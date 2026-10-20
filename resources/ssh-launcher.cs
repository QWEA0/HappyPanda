using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using System.Runtime.InteropServices;

class SshLauncher {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public uint cb;
        public string reserved, desktop, title;
        public uint x, y, width, height, xChars, yChars, fill, flags;
        public ushort show, reservedSize;
        public IntPtr reservedData, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public uint processId, threadId; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder arguments, IntPtr processSecurity,
        IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
        out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static IntPtr Inherit(int id) {
        IntPtr result;
        if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(id), GetCurrentProcess(), out result, 0, true, 2))
            throw new IOException("Unable to inherit SSH stream");
        return result;
    }
    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); }
            else { result.Append('\\', slashes); result.Append(c); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }
    static int Main(string[] args) {
        try {
            string ownPath = System.Reflection.Assembly.GetExecutingAssembly().Location;
            string mode = Path.GetFileNameWithoutExtension(ownPath);
            string configPath = mode == "askpass" ? Environment.GetEnvironmentVariable("HAPPYPANDA_SSH_CONFIG") : Path.Combine(Path.GetDirectoryName(ownPath), "config.json");
            var config = new JavaScriptSerializer().Deserialize<Dictionary<string, string>>(File.ReadAllText(configPath));
            var arguments = new[] { config["executable"], config["script"], configPath, mode }.Concat(args);
            Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "1");
            Environment.SetEnvironmentVariable("NODE_OPTIONS", null);
            // Inherit the exact pipe handles so binary protocols never pass through text streams.
            var startup = new StartupInfo { cb = (uint)Marshal.SizeOf(typeof(StartupInfo)), flags = 0x100,
                input = Inherit(-10), output = Inherit(-11), error = Inherit(-12) };
            ProcessInfo child;
            bool started = CreateProcess(config["executable"], new StringBuilder(String.Join(" ", arguments.Select(Quote))),
                IntPtr.Zero, IntPtr.Zero, true, 0x08000000, IntPtr.Zero, null, ref startup, out child);
            CloseHandle(startup.input); CloseHandle(startup.output); CloseHandle(startup.error);
            if (!started) throw new IOException("Unable to start SSH helper");
            try {
                WaitForSingleObject(child.process, 0xffffffff);
                uint code;
                if (!GetExitCodeProcess(child.process, out code)) return 1;
                return (int)code;
            } finally { CloseHandle(child.thread); CloseHandle(child.process); }
        } catch {
            Console.Error.WriteLine("HappyPanda SSH helper could not start");
            return 1;
        }
    }
}
