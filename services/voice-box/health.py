import json
from pathlib import Path
from unix_http import UnixHTTPConnection

connection = UnixHTTPConnection('/run/voice/gateway/gateway.sock', timeout=3)
connection.request('GET', '/ready', headers={'Authorization': 'Bearer ' + Path('/run/voice/token').read_text().strip()})
response = connection.getresponse()
assert response.status == 200 and json.loads(response.read())['modelsReady'] is True
