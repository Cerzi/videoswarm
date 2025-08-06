#!/usr/bin/env python3
"""
Minimal Python web server for the video browser application.
Solves CORS issues when running ES6 modules locally.
"""

import http.server
import socketserver
import webbrowser
import os
import sys
from pathlib import Path

class VideoServerHandler(http.server.SimpleHTTPRequestHandler):
    """Custom handler with proper MIME types for our application"""
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(Path(__file__).parent), **kwargs)
    
    def end_headers(self):
        # Add CORS headers to allow local development
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        super().end_headers()

def find_available_port(start_port=8347, max_attempts=10):
    """Find an available port starting from start_port"""
    for port in range(start_port, start_port + max_attempts):
        try:
            with socketserver.TCPServer(("", port), None) as test_server:
                return port
        except OSError:
            continue
    return None

def main():
    # Try to find an available port starting from 8347
    PORT = find_available_port()
    
    if PORT is None:
        print("❌ Could not find an available port!")
        print("💡 Try closing other applications or specify a different port range")
        sys.exit(1)
    
    try:
        with socketserver.TCPServer(("", PORT), VideoServerHandler) as httpd:
            print(f"🎬 Video Browser Server starting...")
            print(f"📡 Serving at http://localhost:{PORT}")
            print(f"📁 Directory: {Path.cwd()}")
            print(f"🌐 Opening browser...")
            print(f"⏹️  Press Ctrl+C to stop the server")
            
            # Open browser automatically
            webbrowser.open(f"http://localhost:{PORT}")
            
            # Start serving
            httpd.serve_forever()
            
    except OSError as e:
        print(f"❌ Server error: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print(f"\n🛑 Server stopped by user")
        sys.exit(0)

if __name__ == "__main__":
    main()
