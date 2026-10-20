import json
import os
import pathlib
import socket
import subprocess
import sys
import threading
import time

import paramiko


root = pathlib.Path(sys.argv[1]).resolve()
stopped = threading.Event()
children = []
transports = []
key = paramiko.RSAKey.generate(2048)


def local_path(value):
    target = (root / value.lstrip('/')).resolve()
    if not target.is_relative_to(root):
        raise ValueError('Outside fixture root')
    return target


class Files(paramiko.SFTPServerInterface):
    def open(self, path, flags, attr):
        try:
            target = local_path(path)
            target.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(target, flags, 0o600)
            mode = 'r+b' if flags & os.O_RDWR else 'wb' if flags & os.O_WRONLY else 'rb'
            handle = Handle(flags)
            stream = os.fdopen(fd, mode)
            if flags & (os.O_RDWR | os.O_WRONLY):
                handle.writefile = stream
            if not flags & os.O_WRONLY:
                handle.readfile = stream
            return handle
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    def stat(self, path):
        try:
            return paramiko.SFTPAttributes.from_stat(local_path(path).stat())
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    lstat = stat

    def canonicalize(self, path):
        return '/' + path.lstrip('/')


class Handle(paramiko.SFTPHandle):
    def stat(self):
        return paramiko.SFTPAttributes.from_stat(os.fstat((self.readfile if hasattr(self, 'readfile') else self.writefile).fileno()))

    def chattr(self, attr):
        if attr.st_size is not None:
            self.writefile.truncate(attr.st_size)
        return paramiko.SFTP_OK


class Sftp(paramiko.SFTPServer):
    def finish_subsystem(self):
        self.sock.send_exit_status(0)
        super().finish_subsystem()


def execute(channel, command):
    print(json.dumps({'command': command}), flush=True)
    try:
        if 'mutagen-agent' in command and 'synchronizer' in command:
            agent = root / 'mutagen-agent.exe'
            child = subprocess.Popen([str(agent), 'synchronizer'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            children.append(child)

            def incoming():
                try:
                    while True:
                        data = channel.recv(65536)
                        if not data:
                            break
                        child.stdin.write(data)
                        child.stdin.flush()
                except (OSError, EOFError):
                    pass
                finally:
                    child.stdin.close()

            threading.Thread(target=incoming, daemon=True).start()
            while True:
                data = child.stdout.read1(65536)
                if not data:
                    break
                channel.sendall(data)
            status = child.wait()
            if status:
                print(json.dumps({'agentExit': status, 'error': child.stderr.read().decode(errors='replace')}), flush=True)
            channel.send_exit_status(status)
        elif command == 'echo password-ok':
            channel.sendall(b'password-ok\n')
            channel.send_exit_status(0)
        else:
            channel.send_stderr(b'Unsupported fixture command')
            channel.send_exit_status(127)
    except (OSError, EOFError):
        pass
    finally:
        channel.close()


class Server(paramiko.ServerInterface):
    def check_auth_password(self, username, password):
        accepted = username == 'fixture' and password == os.environ['HP_TEST_PASSWORD']
        print(json.dumps({'auth': accepted}), flush=True)
        return paramiko.AUTH_SUCCESSFUL if accepted else paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return 'password'

    def check_channel_request(self, kind, channel_id):
        return paramiko.OPEN_SUCCEEDED if kind == 'session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_pty_request(self, channel, term, width, height, pixelwidth, pixelheight, modes):
        return True

    def check_channel_exec_request(self, channel, command):
        threading.Thread(target=execute, args=(channel, command.decode()), daemon=True).start()
        return True


def connection(client):
    transport = paramiko.Transport(client)
    transports.append(transport)
    transport.add_server_key(key)
    transport.set_subsystem_handler('sftp', Sftp, Files)
    try:
        transport.start_server(server=Server())
        while transport.is_active() and not stopped.is_set():
            time.sleep(0.05)
    except (EOFError, OSError, paramiko.SSHException):
        pass
    finally:
        transport.close()


def stop():
    sys.stdin.readline()
    stopped.set()


listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen()
listener.settimeout(0.5)
print(json.dumps({'port': listener.getsockname()[1], 'hostKey': key.get_name() + ' ' + key.get_base64()}), flush=True)
threading.Thread(target=stop, daemon=True).start()
while not stopped.is_set():
    try:
        client, _ = listener.accept()
        threading.Thread(target=connection, args=(client,), daemon=True).start()
    except socket.timeout:
        pass
listener.close()
for transport in transports:
    transport.close()
for child in children:
    if child.poll() is None:
        child.kill()
