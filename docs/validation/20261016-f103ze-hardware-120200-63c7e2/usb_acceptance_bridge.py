"""验收专用：原样转发 USB bulk 字节，SWD/寄存器逻辑全部运行生产 JS。"""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import usb.core
import usb.util
import libusb_package

device = usb.core.find(idVendor=0x0D28, idProduct=0x0204,
                       backend=libusb_package.get_libusb1_backend())
if device is None:
    raise RuntimeError('未找到已验收探针')
# This exact descriptor was read from the attached akaLinkPro: IF0, OUT2, IN1.
interface = device.get_active_configuration()[(0, 0)]
assert any(e.bEndpointAddress == 2 and e.bmAttributes & 3 == 2 for e in interface)
assert any(e.bEndpointAddress == 0x81 and e.bmAttributes & 3 == 2 for e in interface)
usb.util.claim_interface(device, 0)
guard = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            with guard:
                op = request['op']
                if op == 'write':
                    value = device.write(2, bytes(request['bytes']), timeout=2500)
                elif op == 'read':
                    value = list(device.read(0x81, 512, timeout=2500))
                elif op == 'quit':
                    value = None
                    threading.Thread(target=server.shutdown, daemon=True).start()
                else:
                    raise ValueError('不支持此 USB 操作')
            body = json.dumps({'value': value}).encode()
            self.send_response(200)
        except Exception as error:
            body = json.dumps({'error': str(error)}).encode()
            self.send_response(400)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 8768), Handler)
try:
    print('Raw USB acceptance bridge ready at 127.0.0.1:8768', flush=True)
    server.serve_forever()
finally:
    usb.util.release_interface(device, 0)
    usb.util.dispose_resources(device)
