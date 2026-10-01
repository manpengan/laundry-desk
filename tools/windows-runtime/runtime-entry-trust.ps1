# Embedded into the generated entry; it never loads unverified companion code.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class LaundryRuntimeEntryTrust {
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    public uint Attributes, CreatedLow, CreatedHigh, AccessLow, AccessHigh,
      WrittenLow, WrittenHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security,
    uint disposition, uint flags, IntPtr template);
  static readonly Dictionary<string, SafeFileHandle> heldDirectories =
    new Dictionary<string, SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
  static Exception Invalid() { return new InvalidOperationException("WINDOWS_RUNTIME_ENTRY_INTEGRITY_FAILED"); }
  static string AbsoluteDirectory(string path) {
    string full = Path.GetFullPath(path);
    if (full.Length > 240 || full.Length < 3 || full[1] != ':' || full[2] != '\\' ||
        full.IndexOf(':', 2) >= 0) throw Invalid();
    return full.Length == 3 ? full : full.TrimEnd('\\');
  }
  static SafeFileHandle DirectoryHandle(string path) {
    // READ_ATTRIBUTES, FILE_SHARE_READ, OPEN_EXISTING; never follow a reparse point.
    SafeFileHandle handle = CreateFileW(path, 0x80, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    FileInfo info;
    if (handle.IsInvalid || !GetFileInformationByHandle(handle, out info) ||
        (info.Attributes & (uint)FileAttributes.ReparsePoint) != 0 ||
        (info.Attributes & (uint)FileAttributes.Directory) == 0) {
      handle.Dispose(); throw Invalid();
    }
    return handle;
  }
  public static string DirectoryPath(string path) {
    string full = AbsoluteDirectory(path);
    DirectoryInfo current = new DirectoryInfo(full);
    while (current != null) {
      using (SafeFileHandle handle = DirectoryHandle(current.FullName)) { }
      current = current.Parent;
    }
    return full;
  }
  public static string HoldDirectoryPath(string path) {
    string full = AbsoluteDirectory(path);
    List<string> ancestors = new List<string>();
    for (DirectoryInfo current = new DirectoryInfo(full); current != null; current = current.Parent)
      ancestors.Add(current.FullName);
    ancestors.Reverse();
    foreach (string ancestor in ancestors)
      if (!heldDirectories.ContainsKey(ancestor)) heldDirectories.Add(ancestor, DirectoryHandle(ancestor));
    return full;
  }
  public static void ReleaseDirectories() {
    foreach (SafeFileHandle handle in heldDirectories.Values) handle.Dispose();
    heldDirectories.Clear();
  }
  static FileStream OpenRegular(string path, long maximum) {
    // GENERIC_READ, FILE_SHARE_READ, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT.
    SafeFileHandle handle = CreateFileW(path, 0x80000000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
    FileInfo info;
    if (handle.IsInvalid || !GetFileInformationByHandle(handle, out info) || info.Links != 1 ||
        (info.Attributes & ((uint)FileAttributes.Directory | (uint)FileAttributes.ReparsePoint)) != 0) {
      handle.Dispose(); throw Invalid();
    }
    FileStream stream;
    try { stream = new FileStream(handle, FileAccess.Read); }
    catch { handle.Dispose(); throw; }
    if (stream.Length > maximum) { stream.Dispose(); throw Invalid(); }
    return stream;
  }
  static FileStream Verify(string path, long size, string digest) {
    if (size < 0 || size > 536870912) throw Invalid();
    FileStream stream = OpenRegular(path, size);
    try {
      if (stream.Length != size) throw Invalid();
      using (SHA256 sha = SHA256.Create()) {
        string actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        if (!String.Equals(actual, digest, StringComparison.Ordinal)) throw Invalid();
      }
      stream.Position = 0;
      return stream;
    } catch { stream.Dispose(); throw; }
  }
  public static FileStream OpenVerified(string path, long size, string digest) {
    HoldDirectoryPath(Path.GetDirectoryName(path));
    return Verify(path, size, digest);
  }
  public static void CheckVerified(string path, long size, string digest) {
    DirectoryPath(Path.GetDirectoryName(path));
    using (FileStream stream = Verify(path, size, digest)) { }
  }
  public static string FileDigest(string path, long maximum) {
    HoldDirectoryPath(Path.GetDirectoryName(path));
    using (FileStream file = OpenRegular(path, maximum)) {
      using (SHA256 sha = SHA256.Create())
        return BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
    }
  }
  public static Task<string> ReadBounded(StreamReader reader) {
    return Task.Factory.StartNew(delegate {
      StringBuilder result = new StringBuilder();
      char[] buffer = new char[4096]; int count;
      while ((count = reader.Read(buffer, 0, buffer.Length)) != 0) {
        if (result.Length + count > 65536) throw Invalid();
        result.Append(buffer, 0, count);
      }
      return result.ToString();
    });
  }
  public static void PrivateDirectory(string path) {
    DirectoryPath(path);
    DirectorySecurity acl = new DirectorySecurity();
    SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
    acl.SetOwner(user); acl.SetAccessRuleProtection(true, false);
    foreach (SecurityIdentifier sid in new SecurityIdentifier[] { user,
      new SecurityIdentifier("S-1-5-18"), new SecurityIdentifier("S-1-5-32-544") })
      acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
        PropagationFlags.None, AccessControlType.Allow));
    new DirectoryInfo(path).SetAccessControl(acl);
    AssertPrivateDirectory(path);
  }
  public static void AssertPrivateDirectory(string path) {
    DirectoryPath(path);
    DirectorySecurity acl = new DirectoryInfo(path).GetAccessControl();
    string user = WindowsIdentity.GetCurrent().User.Value;
    if (!acl.AreAccessRulesProtected || acl.GetOwner(typeof(SecurityIdentifier)).Value != user) throw Invalid();
    AuthorizationRuleCollection rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier));
    if (rules.Count != 3) throw Invalid();
    bool current = false, system = false, admins = false;
    foreach (FileSystemAccessRule rule in rules) {
      string sid = rule.IdentityReference.Value;
      if (rule.IsInherited || rule.AccessControlType != AccessControlType.Allow ||
          rule.FileSystemRights != FileSystemRights.FullControl ||
          rule.InheritanceFlags != (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit) ||
          rule.PropagationFlags != PropagationFlags.None) throw Invalid();
      if (sid == user && !current) current = true;
      else if (sid == "S-1-5-18" && !system) system = true;
      else if (sid == "S-1-5-32-544" && !admins) admins = true;
      else throw Invalid();
    }
    if (!current || !system || !admins) throw Invalid();
  }
}
'@
