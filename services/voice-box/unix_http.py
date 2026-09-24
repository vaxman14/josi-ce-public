import http.client
import socket


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout=45):
        super().__init__('localhost', timeout=timeout)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)
