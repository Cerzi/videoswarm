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
import json
import tempfile
import shutil
from pathlib import Path
from urllib.parse import unquote

class VideoServerHandler(http.server.SimpleHTTPRequestHandler):
    """Custom handler with proper MIME types and range request support for video files"""
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(Path(__file__).parent), **kwargs)
    
    def end_headers(self):
        # Add CORS headers to allow local development
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        super().end_headers()
    
    def do_POST(self):
        """Handle POST requests for file uploads"""
        if self.path == '/upload':
            try:
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                
                # Parse multipart form data (simplified)
                boundary = self.headers['Content-Type'].split('boundary=')[1]
                parts = post_data.split(f'--{boundary}'.encode())
                
                uploaded_files = []
                
                for part in parts[1:-1]:  # Skip first empty part and last closing part
                    if b'Content-Disposition' in part:
                        # Extract filename
                        header_end = part.find(b'\r\n\r\n')
                        headers = part[:header_end].decode('utf-8')
                        file_data = part[header_end + 4:]
                        
                        # Remove trailing \r\n
                        if file_data.endswith(b'\r\n'):
                            file_data = file_data[:-2]
                        
                        # Extract filename from headers
                        filename_start = headers.find('filename="') + 10
                        filename_end = headers.find('"', filename_start)
                        filename = headers[filename_start:filename_end]
                        
                        if filename and file_data:
                            # Create temp directory if it doesn't exist
                            if not hasattr(self.server, 'temp_dir'):
                                self.server.temp_dir = tempfile.mkdtemp(prefix='video_browser_')
                            
                            # Save file to temp directory
                            file_path = os.path.join(self.server.temp_dir, filename)
                            with open(file_path, 'wb') as f:
                                f.write(file_data)
                            
                            # Store in uploaded_videos mapping
                            self.server.uploaded_videos[filename] = file_path
                            uploaded_files.append(filename)
                
                # Send success response
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                response = json.dumps({'success': True, 'files': uploaded_files})
                self.wfile.write(response.encode())
                
            except Exception as e:
                self.send_error(500, f"Upload failed: {str(e)}")
            return
        
        # Handle other POST requests
        self.send_error(404, "Not found")

    def do_GET(self):
        """Handle GET requests with proper range support for video files"""
        # Handle video requests from /videos/ path
        if self.path.startswith('/videos/'):
            video_filename = unquote(self.path[8:])  # Remove '/videos/' prefix and decode URL
            video_filename = video_filename.split('?')[0]  # Remove query params
            
            # Find the video file in uploaded videos
            if hasattr(self.server, 'uploaded_videos') and video_filename in self.server.uploaded_videos:
                file_path = self.server.uploaded_videos[video_filename]
                
                if os.path.exists(file_path):
                    range_header = self.headers.get('Range')
                    if range_header:
                        return self.handle_range_request(file_path, range_header)
                    else:
                        return self.handle_full_request(file_path)
            
            # Video not found
            self.send_error(404, f"Video not found: {video_filename}")
            return
        
        # Handle regular file requests
        path = self.translate_path(self.path)
        
        # Check if file exists
        if not os.path.exists(path) or os.path.isdir(path):
            return super().do_GET()
        
        # Check if it's a video file
        video_extensions = ('.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv', '.wmv', '.3gp', '.ogv')
        if not path.lower().endswith(video_extensions):
            return super().do_GET()
        
        # Handle range requests for video files
        range_header = self.headers.get('Range')
        if range_header:
            return self.handle_range_request(path, range_header)
        else:
            return self.handle_full_request(path)
    
    def handle_range_request(self, path, range_header):
        """Handle HTTP range requests for video streaming"""
        try:
            file_size = os.path.getsize(path)
            
            # Parse range header (e.g., "bytes=0-1023")
            range_match = range_header.replace('bytes=', '').split('-')
            start = int(range_match[0]) if range_match[0] else 0
            end = int(range_match[1]) if range_match[1] else file_size - 1
            
            # Ensure valid range
            start = max(0, start)
            end = min(file_size - 1, end)
            content_length = end - start + 1
            
            # Send partial content response
            self.send_response(206)  # Partial Content
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Content-Length', str(content_length))
            self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
            self.send_header('Accept-Ranges', 'bytes')
            self.end_headers()
            
            # Send the requested byte range
            with open(path, 'rb') as f:
                f.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk_size = min(8192, remaining)
                    chunk = f.read(chunk_size)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
                    
        except (ValueError, OSError) as e:
            self.send_error(416, "Requested Range Not Satisfiable")
    
    def handle_full_request(self, path):
        """Handle full file requests"""
        try:
            file_size = os.path.getsize(path)
            
            self.send_response(200)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Content-Length', str(file_size))
            self.send_header('Accept-Ranges', 'bytes')
            self.end_headers()
            
            with open(path, 'rb') as f:
                while True:
                    chunk = f.read(8192)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    
        except OSError:
            self.send_error(404, "File not found")

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
            # Initialize uploaded videos storage
            httpd.uploaded_videos = {}
            httpd.temp_dir = None
            
            print(f"🎬 Video Browser Server starting...")
            print(f"📡 Serving at http://localhost:{PORT}")
            print(f"📁 Directory: {Path.cwd()}")
            print(f"🌐 Opening browser...")
            print(f"⏹️  Press Ctrl+C to stop the server")
            
            # Open browser automatically
            webbrowser.open(f"http://localhost:{PORT}")
            
            try:
                # Start serving
                httpd.serve_forever()
            finally:
                # Cleanup temp directory on shutdown
                if hasattr(httpd, 'temp_dir') and httpd.temp_dir and os.path.exists(httpd.temp_dir):
                    shutil.rmtree(httpd.temp_dir)
                    print(f"🧹 Cleaned up temporary files")
            
    except OSError as e:
        print(f"❌ Server error: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print(f"\n🛑 Server stopped by user")
        sys.exit(0)

if __name__ == "__main__":
    main()
