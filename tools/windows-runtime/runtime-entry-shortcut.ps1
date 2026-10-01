# Hash-bound helper. Use explicit wide Shell Link fields and .NET Unicode file paths,
# never WScript.Shell's locale-dependent shortcut filename conversion.
if (-not ('LaundryRuntimeUnicodeShortcut' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using STATSTG = System.Runtime.InteropServices.ComTypes.STATSTG;
using Microsoft.Win32.SafeHandles;

public sealed class LaundryRuntimeUnicodeShortcut : IDisposable {
  const int MaximumBytes = 1048576;
  const int MaximumCharacters = 32768;
  [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr data, uint flags);
    void GetIDList(out IntPtr list);
    void SetIDList(IntPtr list);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int count);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string text);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string path);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int count);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string text);
    void GetHotkey(out ushort key);
    void SetHotkey(ushort key);
    void GetShowCmd(out int command);
    void SetShowCmd(int command);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, out int index);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
    void Resolve(IntPtr window, uint flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
  }
  [ComImport, Guid("00000109-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPersistStream {
    void GetClassID(out Guid id);
    [PreserveSig] int IsDirty();
    void Load(IStream stream);
    void Save(IStream stream, [MarshalAs(UnmanagedType.Bool)] bool clearDirty);
    void GetSizeMax(out long size);
  }
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    public uint Attributes, CreatedLow, CreatedHigh, AccessLow, AccessHigh,
      WrittenLow, WrittenHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security,
    uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);

  // A managed IStream enforces the bound during COM serialization, before allocation or file creation.
  [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
  public sealed class BoundedStream : IStream, IDisposable {
    readonly MemoryStream memory = new MemoryStream();
    public BoundedStream() { }
    public BoundedStream(byte[] bytes) { Write(bytes, bytes.Length, IntPtr.Zero); memory.Position = 0; }
    public byte[] Bytes() { return memory.ToArray(); }
    public void Read(byte[] buffer, int count, IntPtr read) {
      if (count < 0 || count > buffer.Length) throw Conflict();
      int actual = memory.Read(buffer, 0, count);
      if (read != IntPtr.Zero) Marshal.WriteInt32(read, actual);
    }
    public void Write(byte[] buffer, int count, IntPtr written) {
      if (count < 0 || count > buffer.Length || memory.Position > MaximumBytes - count) throw Conflict();
      memory.Write(buffer, 0, count);
      if (written != IntPtr.Zero) Marshal.WriteInt32(written, count);
    }
    public void Seek(long offset, int origin, IntPtr position) {
      long basis = origin == 0 ? 0 : origin == 1 ? memory.Position : origin == 2 ? memory.Length : -1;
      if (basis < 0 || offset < -basis || offset > MaximumBytes - basis) throw Conflict();
      memory.Position = basis + offset;
      if (position != IntPtr.Zero) Marshal.WriteInt64(position, memory.Position);
    }
    public void SetSize(long size) {
      if (size < 0 || size > MaximumBytes) throw Conflict();
      memory.SetLength(size);
    }
    public void Stat(out STATSTG value, int flags) {
      value = new STATSTG(); value.type = 2; value.cbSize = memory.Length;
    }
    public void Commit(int flags) { memory.Flush(); }
    public void Revert() { throw new COMException("", unchecked((int)0x80004001)); }
    public void LockRegion(long offset, long size, int type) { throw new COMException("", unchecked((int)0x80004001)); }
    public void UnlockRegion(long offset, long size, int type) { throw new COMException("", unchecked((int)0x80004001)); }
    public void Clone(out IStream stream) { stream = null; throw new COMException("", unchecked((int)0x80004001)); }
    public void CopyTo(IStream stream, long count, IntPtr read, IntPtr written) { throw new COMException("", unchecked((int)0x80004001)); }
    public void Dispose() { memory.Dispose(); }
  }
  object native;
  IShellLinkW link;
  IPersistStream persistence;
  FileStream existing;
  public string FullName { get; private set; }
  public bool Existed { get; private set; }
  static Exception Conflict() { return new InvalidOperationException("WINDOWS_RUNTIME_ENTRY_SHORTCUT_CONFLICT"); }
  static void Regular(SafeFileHandle handle) {
    FileInfo info;
    if (handle.IsInvalid || !GetFileInformationByHandle(handle, out info) || info.Links != 1 ||
        (info.Attributes & ((uint)FileAttributes.Directory | (uint)FileAttributes.ReparsePoint)) != 0) throw Conflict();
  }
  static byte[] ReadExisting(FileStream stream) {
    if (stream.Length < 76 || stream.Length > MaximumBytes) throw Conflict();
    byte[] bytes = new byte[(int)stream.Length];
    int offset = 0;
    while (offset < bytes.Length) {
      int count = stream.Read(bytes, offset, bytes.Length - offset);
      if (count == 0) throw Conflict();
      offset += count;
    }
    if (stream.ReadByte() != -1 || BitConverter.ToUInt32(bytes, 0) != 76) throw Conflict();
    byte[] id = new byte[16]; Array.Copy(bytes, 4, id, 0, 16);
    if (new Guid(id) != new Guid("00021401-0000-0000-C000-000000000046")) throw Conflict();
    return bytes;
  }
  public LaundryRuntimeUnicodeShortcut(string path) {
    FullName = Path.GetFullPath(path);
    if (FullName != path || path.Length > 32767 || path.Length < 4 || path[1] != ':' ||
        path[2] != '\\' || path.IndexOf(':', 2) >= 0 || !path.EndsWith(".lnk", StringComparison.Ordinal)) throw Conflict();
    try {
      native = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046"), true));
      link = (IShellLinkW)native; persistence = (IPersistStream)native;
      // OPEN_EXISTING + OPEN_REPARSE_POINT + BACKUP_SEMANTICS inspects the leaf itself.
      SafeFileHandle handle = CreateFileW(path, 0x80000000, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
      if (handle.IsInvalid) {
        int error = Marshal.GetLastWin32Error(); handle.Dispose();
        if (error != 2) throw Conflict();
        return;
      }
      try { Regular(handle); existing = new FileStream(handle, FileAccess.Read); }
      catch { handle.Dispose(); throw; }
      byte[] bytes = ReadExisting(existing);
      using (BoundedStream stream = new BoundedStream(bytes)) {
        try { persistence.Load(stream); } catch { throw Conflict(); }
      }
      Existed = true;
    } catch { Dispose(); throw; }
  }
  string ReadText(Action<StringBuilder, int> read) {
    StringBuilder text = new StringBuilder(MaximumCharacters);
    read(text, text.Capacity);
    if (text.Length >= MaximumCharacters - 1) throw Conflict();
    return text.ToString();
  }
  static string Text(string value) {
    if (value == null || value.Length >= MaximumCharacters - 1 || value.IndexOf('\0') >= 0) throw Conflict();
    return value;
  }
  public string TargetPath {
    get { return ReadText(delegate(StringBuilder text, int count) { link.GetPath(text, count, IntPtr.Zero, 4); }); }
    set { link.SetPath(Text(value)); }
  }
  public string Arguments { get { return ReadText(link.GetArguments); } set { link.SetArguments(Text(value)); } }
  public string WorkingDirectory { get { return ReadText(link.GetWorkingDirectory); } set { link.SetWorkingDirectory(Text(value)); } }
  public string Description { get { return ReadText(link.GetDescription); } set { link.SetDescription(Text(value)); } }
  public void Save() {
    if (Existed) throw Conflict();
    byte[] bytes;
    using (BoundedStream stream = new BoundedStream()) {
      long maximum; persistence.GetSizeMax(out maximum);
      if (maximum < 76 || maximum > MaximumBytes) throw Conflict();
      persistence.Save(stream, true); bytes = stream.Bytes();
    }
    if (bytes.Length < 76 || bytes.Length > MaximumBytes) throw Conflict();
    // CreateNew never truncates an unknown file, including one created after the initial probe.
    using (FileStream file = new FileStream(FullName, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
      Regular(file.SafeFileHandle);
      file.Write(bytes, 0, bytes.Length); file.Flush(true);
      if (file.Length != bytes.Length || file.Position != bytes.Length) throw Conflict();
      Regular(file.SafeFileHandle);
    }
  }
  public void Dispose() {
    try { if (existing != null) { existing.Dispose(); existing = null; } }
    finally {
      object release = native; native = null; link = null; persistence = null;
      if (release != null) Marshal.FinalReleaseComObject(release);
    }
  }
}
'@
}
