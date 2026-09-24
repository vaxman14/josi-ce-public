"""Build-time neural inference smoke check, including emulated arm64 builds."""
import io
import wave
import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.vad import get_speech_timestamps, VadOptions
from settings import DEFAULTS
from tts import NeuralSpeech


def smoke():
    speech = NeuralSpeech(DEFAULTS)
    with wave.open(io.BytesIO(speech.speech('Please remember to buy apples tomorrow.'))) as wav:
        assert wav.getnchannels() == 1 and wav.getsampwidth() == 2 and wav.getframerate() == 24000
        data = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768
    audio = np.interp(np.arange(0, len(data), 1.5), np.arange(len(data)), data).astype(np.float32)
    assert get_speech_timestamps(audio, VadOptions())
    model = WhisperModel('/models/base.en', device='cpu', compute_type='int8', cpu_threads=4, local_files_only=True)
    segments, _ = model.transcribe(audio, language='en', beam_size=1, vad_filter=True)
    text = ' '.join(part.text for part in segments).lower()
    assert 'apples' in text and 'tomorrow' in text, text
    print('PASS Kokoro PCM WAV → Silero VAD → faster-whisper CPU transcription')


if __name__ == '__main__':
    smoke()
