# Explicit inheritance is required on .NET Framework: Process.Start can pass
# hidden caller pipe handles to descendants even with redirected standard IO.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class LaundryRuntimeNativeLauncher {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct StartupInfo {
    public int Size;
    public string Reserved, Desktop, Title;
    public int X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public short ShowWindow, ReservedSize;
    public IntPtr ReservedData, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct StartupInfoEx {
    public StartupInfo Startup;
    public IntPtr Attributes;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct ProcessInformation {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  private static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")]
  private static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation process);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool TerminateProcess(IntPtr process, uint code);

  private static IntPtr StandardHandle(int kind) {
    // The controller has no input protocol. Use NUL instead of caller stdin.
    IntPtr source = kind == -10 ? IntPtr.Zero : GetStdHandle(kind);
    bool owned = source == IntPtr.Zero || source == new IntPtr(-1);
    if (owned) source = CreateFileW("NUL", kind == -10 ? 0x80000000u : 0x40000000u, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (source == new IntPtr(-1)) throw new InvalidOperationException("WINDOWS_COMPANION_LAUNCH_HANDLE_FAILED");
    try {
      IntPtr copy;
      if (!DuplicateHandle(new IntPtr(-1), source, new IntPtr(-1), out copy, 0, true, 2))
        throw new InvalidOperationException("WINDOWS_COMPANION_LAUNCH_HANDLE_FAILED");
      return copy;
    } finally { if (owned) CloseHandle(source); }
  }

  public static int Run(string executable, string arguments, string directory) {
    IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
    IntPtr list = IntPtr.Zero, values = IntPtr.Zero;
    bool initialized = false;
    ProcessInformation process = new ProcessInformation();
    try {
      input = StandardHandle(-10); output = StandardHandle(-11); error = StandardHandle(-12);
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      if (size == IntPtr.Zero) throw new InvalidOperationException("WINDOWS_COMPANION_LAUNCH_ATTRIBUTES_FAILED");
      list = Marshal.AllocHGlobal(size);
      if (!InitializeProcThreadAttributeList(list, 1, 0, ref size))
        throw new InvalidOperationException("WINDOWS_COMPANION_LAUNCH_ATTRIBUTES_FAILED");
      initialized = true;
      values = Marshal.AllocHGlobal(IntPtr.Size * 3);
      Marshal.WriteIntPtr(values, 0, input);
      Marshal.WriteIntPtr(values, IntPtr.Size, output);
      Marshal.WriteIntPtr(values, IntPtr.Size * 2, error);
      if (!UpdateProcThreadAttribute(list, 0, new IntPtr(0x20002), values, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
        throw new InvalidOperationException("WINDOWS_COMPANION_LAUNCH_ATTRIBUTES_FAILED");
      StartupInfoEx startup = new StartupInfoEx();
      startup.Startup.Size = Marshal.SizeOf(typeof(StartupInfoEx));
      startup.Startup.Flags = 0x100;
      startup.Startup.Input = input; startup.Startup.Output = output; startup.Startup.Error = error;
      startup.Attributes = list;
      // EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, without a shell.
      if (!CreateProcessW(executable, new StringBuilder("\"" + executable + "\" " + arguments), IntPtr.Zero, IntPtr.Zero, true, 0x08080000, IntPtr.Zero, directory, ref startup, out process))
        throw new InvalidOperationException("WINDOWS_COMPANION_LAUNCH_PROCESS_FAILED");
      uint waited = WaitForSingleObject(process.Process, 900000);
      if (waited == 258) {
        TerminateProcess(process.Process, 1);
        WaitForSingleObject(process.Process, 5000);
        throw new InvalidOperationException("WINDOWS_COMPANION_LAUNCH_TIMEOUT");
      }
      uint code;
      if (waited != 0 || !GetExitCodeProcess(process.Process, out code))
        throw new InvalidOperationException("WINDOWS_COMPANION_LAUNCH_WAIT_FAILED");
      return unchecked((int)code);
    } finally {
      if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
      if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
      if (initialized) DeleteProcThreadAttributeList(list);
      if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
      if (values != IntPtr.Zero) Marshal.FreeHGlobal(values);
      if (input != IntPtr.Zero) CloseHandle(input);
      if (output != IntPtr.Zero) CloseHandle(output);
      if (error != IntPtr.Zero) CloseHandle(error);
    }
  }
}
'@
