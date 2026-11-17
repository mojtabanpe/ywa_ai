# Serves /json/version for a Chrome whose remote debugging was enabled from chrome://inspect
# (that mode exposes only the websocket, and its DevToolsActivePort file is unreadable here).
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

WS = "ws://127.0.0.1:9222/devtools/browser"

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.rstrip("/") in ("/json/version", "/json"):
            body = json.dumps({"Browser": "Chrome", "Protocol-Version": "1.3", "webSocketDebuggerUrl": WS}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):
        pass

HTTPServer(("127.0.0.1", 9333), H).serve_forever()
