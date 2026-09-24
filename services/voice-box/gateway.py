"""Bounded PCM streaming sessions, Silero endpointing and offline speech.

Transport is ordered 500 ms PCM frames over HTTP, with incremental hypotheses
and final transcripts returned as events. Audio is kept only in bounded memory.
Josi's API binds every session to its authenticated owner; this private gateway
requires the installation token on every request, including health.
"""
import base64
import hmac
import io
import json
import os
from pathlib import Path
import secrets
import socketserver
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler
import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.vad import VadOptions, get_speech_timestamps
from settings import validate
from tts import NeuralSpeech
from bounded_http import BoundedRequests

RATE = 16000
MAX_SAMPLES = 15 * RATE


class Engine:
    def __init__(self):
        self.config = validate(json.loads(Path('/run/voice/settings.json').read_text()))
        self.token = Path('/run/voice/token').read_text().strip()
        if len(self.token) < 32:
            raise ValueError('Missing gateway credential')
        self.sessions, self.lock = {}, threading.Lock()
        self.tts_lock = threading.Lock()
        self.ready = False
        self.failure = None
        threading.Thread(target=self.load, daemon=True).start()

    def load(self):
        try:
            self.model = WhisperModel('/models/' + self.config['model'], device=self.config['device'],
                                      compute_type='int8' if self.config['device'] == 'cpu' else 'int8_float16',
                                      cpu_threads=4, num_workers=1, local_files_only=True)
            self.tts = NeuralSpeech(self.config)
            segments, _ = self.model.transcribe(np.zeros(RATE, dtype=np.float32), language='en', vad_filter=False)
            list(segments)
            get_speech_timestamps(np.zeros(RATE, dtype=np.float32), VadOptions())
            self.speech('Voice Box is ready to talk with you.')
            self.ready = True
        except Exception:
            self.failure = 'A speech model could not load or complete its warm-up test'

    def transcribe(self, audio):
        segments, _ = self.model.transcribe(audio, language='en', beam_size=1,
                                            condition_on_previous_text=False, vad_filter=True)
        return ' '.join(s.text.strip() for s in segments if s.no_speech_prob < 0.6).strip()

    def speech(self, text):
        return self.tts.speech(text)

    def request(self, path, body):
        if path == '/speech':
            if set(body) != {'text'} or not isinstance(body['text'], str) or not 1 <= len(body['text']) <= 600:
                raise ValueError('Invalid speech text')
            if not self.tts_lock.acquire(blocking=False):
                return 429, {'error': 'Speech generation is busy'}
            try:
                return 200, self.speech(body['text'])
            finally:
                self.tts_lock.release()
        if not self.lock.acquire(blocking=False):
            return 429, {'error': 'Voice Box is busy; try again shortly'}
        try:
            now = time.monotonic()
            self.sessions = {key: value for key, value in self.sessions.items() if now - value['at'] < 60}
            if path == '/session':
                if body != {} or len(self.sessions) >= 4:
                    return 429, {'error': 'Voice session limit reached'}
                key = secrets.token_hex(24)
                self.sessions[key] = {'audio': np.empty(0, dtype=np.float32), 'at': now,
                                      'seq': 0, 'partial': 0, 'speaking': False}
                return 200, {'session': key}
            key = body.get('session')
            if not isinstance(key, str) or key not in self.sessions:
                return 404, {'error': 'Voice session expired'}
            if path == '/close':
                if set(body) != {'session'}:
                    raise ValueError('Invalid close request')
                del self.sessions[key]
                return 200, {'closed': True}
            if path != '/audio' or set(body) != {'session', 'seq', 'pcm'}:
                raise ValueError('Invalid audio request')
            session = self.sessions[key]
            if type(body['seq']) is not int or body['seq'] != session['seq']:
                return 409, {'error': 'Audio sequence mismatch; start a new session'}
            if not isinstance(body['pcm'], str) or len(body['pcm']) > 44000:
                raise ValueError('Audio frame is too large')
            pcm = base64.b64decode(body['pcm'], validate=True)
            if not 320 <= len(pcm) <= 32000 or len(pcm) % 2:
                raise ValueError('Expected mono PCM16 at 16 kHz, at most one second')
            frame = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768
            session['seq'] += 1
            session['at'] = now
            session['audio'] = audio = np.concatenate((session['audio'], frame))[-MAX_SAMPLES:]
            timestamps = get_speech_timestamps(audio, VadOptions(threshold=self.config['threshold'],
                min_speech_duration_ms=150, min_silence_duration_ms=int(self.config['silenceMs']), speech_pad_ms=30))
            events = []
            if timestamps:
                if not session['speaking']:
                    events.append({'type': 'speech_start'})
                    session['speaking'] = True
                final = (len(audio) - timestamps[-1]['end']) / RATE * 1000 >= self.config['silenceMs'] or len(audio) >= MAX_SAMPLES
                if final or len(audio) - session['partial'] >= RATE:
                    text = self.transcribe(audio)
                    events.append({'type': 'final' if final else 'partial', 'text': text})
                    session['partial'] = len(audio)
                if final:
                    session.update(audio=np.empty(0, dtype=np.float32), partial=0, speaking=False)
            else:
                # Retain just enough pre-roll when the room is silent.
                session['audio'] = audio[-RATE:]
                session['partial'] = 0
            return 200, {'events': events}
        finally:
            self.lock.release()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def dispatch(self):
        engine = self.server.engine
        if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + engine.token):
            self.reply(401, {'error': 'Unauthorized'})
            return
        if self.command == 'GET' and self.path in ('/health', '/ready'):
            self.reply(200 if self.path == '/health' or engine.ready else 503,
                       {'apiReady': True, 'modelsReady': engine.ready, 'error': engine.failure, 'version': '0.1.0'})
            return
        if not engine.ready:
            self.reply(503, {'error': 'Speech models are not ready'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if self.command != 'POST' or self.headers.get('Transfer-Encoding') or not 0 < length <= 50000:
                raise ValueError('Invalid request')
            self.connection.settimeout(10)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError('Invalid request')
            status, result = engine.request(self.path, body)
            self.reply(status, result)
        except (ValueError, KeyError, TypeError):
            self.reply(400, {'error': 'Invalid voice request'})
        except Exception:
            self.reply(503, {'error': 'Speech processing failed'})

    def reply(self, status, result):
        audio = isinstance(result, bytes)
        data = result if audio else json.dumps(result).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'audio/wav' if audio else 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Server(BoundedRequests, socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


if __name__ == '__main__':
    engine = Engine()
    path = Path('/run/voice/gateway/gateway.sock')
    if path.exists():
        if not path.is_socket():
            raise ValueError('Gateway path is not a socket')
        path.unlink()
    server = Server(str(path), Handler)
    path.chmod(0o600)
    server.engine = engine
    server.serve_forever()
