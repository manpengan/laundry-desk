using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing.Printing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Laundry.WindowsHelper
{
    internal static class Program
    {
        private sealed class PrintSubmissionUncertainException : Exception { }

        private const int MaximumPrintBytes = 1024 * 1024;
        private const uint GenericRead = 0x80000000;
        private const uint GenericWrite = 0x40000000;
        private const uint ReadControl = 0x00020000;
        private const uint ShareAll = 0x00000001 | 0x00000002 | 0x00000004;
        private const uint OpenExisting = 3;
        private const uint BackupSemantics = 0x02000000;
        private const uint OpenReparsePoint = 0x00200000;
        private const uint ReplaceExisting = 0x00000001;
        private const uint WriteThrough = 0x00000008;
        private const uint FileAttributeReparsePoint = 0x00000400;
        private const uint FileAttributeDirectory = 0x00000010;

        [StructLayout(LayoutKind.Sequential)]
        private struct ByHandleFileInformation
        {
            public uint FileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct DocInfo
        {
            [MarshalAs(UnmanagedType.LPWStr)] public string DocumentName;
            [MarshalAs(UnmanagedType.LPWStr)] public string OutputFile;
            [MarshalAs(UnmanagedType.LPWStr)] public string DataType;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFile(
            string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FlushFileBuffers(SafeFileHandle handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle handle, out ByHandleFileInformation information);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool MoveFileEx(string source, string destination, uint flags);

        [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool OpenPrinter(string printerName, out IntPtr printer, IntPtr defaults);

        [DllImport("winspool.drv", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ClosePrinter(IntPtr printer);

        [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint StartDocPrinter(IntPtr printer, uint level, ref DocInfo document);

        [DllImport("winspool.drv", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool EndDocPrinter(IntPtr printer);

        [DllImport("winspool.drv", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AbortPrinter(IntPtr printer);

        [DllImport("winspool.drv", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WritePrinter(IntPtr printer, byte[] bytes, uint count, out uint written);

        private static int Main(string[] arguments)
        {
            try
            {
                Dispatch(arguments);
                return 0;
            }
            catch (PrintSubmissionUncertainException)
            {
                Console.Error.WriteLine("WINDOWS_HELPER_UNCERTAIN");
                return 2;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(
                    "WINDOWS_HELPER_FAILED:" + error.GetType().Name + ":" + error.HResult.ToString("x8"));
                return 1;
            }
        }

        private static void Dispatch(string[] arguments)
        {
            if (arguments.Length == 2 && arguments[0] == "flush-directory") FlushDirectory(arguments[1]);
            else if (arguments.Length == 3 && arguments[0] == "replace-file") ReplaceFile(arguments[1], arguments[2]);
            else if (arguments.Length == 2 && arguments[0] == "secure-file") SecureFile(arguments[1]);
            else if (arguments.Length == 2 && arguments[0] == "inspect-private-file") InspectPrivateFile(arguments[1]);
            else if (arguments.Length == 3 && arguments[0] == "inspect-private-file-links") InspectPrivateFileLinks(arguments[1], arguments[2]);
            else if (arguments.Length == 2 && arguments[0] == "secure-directory") SecureDirectory(arguments[1]);
            else if (arguments.Length == 2 && arguments[0] == "inspect-private-directory") InspectPrivateDirectory(arguments[1]);
            else if (arguments.Length == 1 && arguments[0] == "list-printers") ListPrinters();
            else if (arguments.Length == 2 && arguments[0] == "print-raw") PrintRaw(arguments[1]);
            else throw new InvalidOperationException();
        }

        private static string CanonicalPath(string raw)
        {
            if (String.IsNullOrWhiteSpace(raw) || raw.IndexOf('\0') >= 0) throw new InvalidOperationException();
            string full = Path.GetFullPath(raw);
            if (!String.Equals(full, raw, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
            return full;
        }

        private static ByHandleFileInformation ReadIdentity(string raw, bool directory, uint expectedLinks = 1)
        {
            string path = CanonicalPath(raw);
            uint flags = OpenReparsePoint | (directory ? BackupSemantics : 0);
            using (SafeFileHandle handle = CreateFile(path, ReadControl, ShareAll, IntPtr.Zero, OpenExisting, flags, IntPtr.Zero))
            {
                if (handle.IsInvalid) throw new InvalidOperationException();
                ByHandleFileInformation information;
                if (!GetFileInformationByHandle(handle, out information)) throw new InvalidOperationException();
                bool isDirectory = (information.FileAttributes & FileAttributeDirectory) != 0;
                if (isDirectory != directory || (information.FileAttributes & FileAttributeReparsePoint) != 0)
                    throw new InvalidOperationException();
                if (!directory && information.NumberOfLinks != expectedLinks) throw new InvalidOperationException();
                return information;
            }
        }

        private static void FlushDirectory(string raw)
        {
            string path = CanonicalPath(raw);
            ReadIdentity(path, true);
            using (SafeFileHandle handle = CreateFile(
                path, GenericWrite, ShareAll, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero))
            {
                if (handle.IsInvalid || !FlushFileBuffers(handle)) throw new InvalidOperationException();
            }
            ReadIdentity(path, true);
            WriteOk();
        }

        private static void ReplaceFile(string rawSource, string rawDestination)
        {
            string source = CanonicalPath(rawSource);
            string destination = CanonicalPath(rawDestination);
            ReadIdentity(source, false);
            if (File.Exists(destination)) ReadIdentity(destination, false);
            if (!MoveFileEx(source, destination, ReplaceExisting | WriteThrough)) throw new InvalidOperationException();
            ReadIdentity(destination, false);
            WriteOk();
        }

        private static SecurityIdentifier CurrentUserSid()
        {
            WindowsIdentity identity = WindowsIdentity.GetCurrent();
            if (identity.User == null) throw new InvalidOperationException();
            return identity.User;
        }

        private static void NormalizeCurrentOwner(
            FileSystemSecurity security, SecurityIdentifier current)
        {
            SecurityIdentifier owner = (SecurityIdentifier)security.GetOwner(typeof(SecurityIdentifier));
            if (owner.Equals(current)) return;

            SecurityIdentifier administrators = new SecurityIdentifier(
                WellKnownSidType.BuiltinAdministratorsSid, null);
            WindowsPrincipal principal = new WindowsPrincipal(WindowsIdentity.GetCurrent());
            if (!owner.Equals(administrators) || !principal.IsInRole(WindowsBuiltInRole.Administrator))
                throw new InvalidOperationException();
            security.SetOwner(current);
        }

        private static FileSecurity PrivateSecurity(string path, SecurityIdentifier owner)
        {
            FileSecurity security = File.GetAccessControl(
                path, AccessControlSections.Owner | AccessControlSections.Access);
            NormalizeCurrentOwner(security, owner);
            security.SetAccessRuleProtection(true, false);
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, false, typeof(SecurityIdentifier)))
                security.RemoveAccessRuleSpecific(rule);
            security.AddAccessRule(new FileSystemAccessRule(owner, FileSystemRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                FileSystemRights.FullControl, AccessControlType.Allow));
            return security;
        }

        private static DirectorySecurity PrivateDirectorySecurity(string path, SecurityIdentifier owner)
        {
            DirectorySecurity security = Directory.GetAccessControl(
                path, AccessControlSections.Owner | AccessControlSections.Access);
            NormalizeCurrentOwner(security, owner);
            security.SetAccessRuleProtection(true, false);
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, false, typeof(SecurityIdentifier)))
                security.RemoveAccessRuleSpecific(rule);
            InheritanceFlags inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
            security.AddAccessRule(new FileSystemAccessRule(
                owner, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
            return security;
        }

        private static string VerifyPrivateFile(string raw, uint expectedLinks)
        {
            string path = CanonicalPath(raw);
            ReadIdentity(path, false, expectedLinks);
            SecurityIdentifier current = CurrentUserSid();
            SecurityIdentifier system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            FileSecurity security = File.GetAccessControl(path, AccessControlSections.Owner | AccessControlSections.Access);
            SecurityIdentifier owner = (SecurityIdentifier)security.GetOwner(typeof(SecurityIdentifier));
            if (!owner.Equals(current) || !security.AreAccessRulesProtected) throw new InvalidOperationException();
            AuthorizationRuleCollection rules = security.GetAccessRules(true, false, typeof(SecurityIdentifier));
            if (rules.Count != 2) throw new InvalidOperationException();
            HashSet<string> expected = new HashSet<string>(new[] { current.Value, system.Value }, StringComparer.Ordinal);
            foreach (FileSystemAccessRule rule in rules)
            {
                SecurityIdentifier sid = (SecurityIdentifier)rule.IdentityReference;
                if (rule.IsInherited || rule.AccessControlType != AccessControlType.Allow ||
                    rule.FileSystemRights != FileSystemRights.FullControl || !expected.Remove(sid.Value))
                    throw new InvalidOperationException();
            }
            if (expected.Count != 0) throw new InvalidOperationException();
            return security.GetSecurityDescriptorSddlForm(AccessControlSections.Owner | AccessControlSections.Access);
        }

        private static void SecureFile(string raw)
        {
            string path = CanonicalPath(raw);
            ReadIdentity(path, false);
            SecurityIdentifier current = CurrentUserSid();
            File.SetAccessControl(path, PrivateSecurity(path, current));
            VerifyPrivateFile(path, 1);
            WriteOk();
        }

        private static void InspectPrivateFile(string raw)
        {
            WriteDescriptor(VerifyPrivateFile(raw, 1));
        }

        private static void InspectPrivateFileLinks(string raw, string rawLinks)
        {
            uint expectedLinks;
            if (!UInt32.TryParse(rawLinks, out expectedLinks) || (expectedLinks != 1 && expectedLinks != 2))
                throw new InvalidOperationException();
            WriteDescriptor(VerifyPrivateFile(raw, expectedLinks));
        }

        private static string VerifyPrivateDirectory(string raw)
        {
            string path = CanonicalPath(raw);
            ReadIdentity(path, true);
            SecurityIdentifier current = CurrentUserSid();
            SecurityIdentifier system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            DirectorySecurity security = Directory.GetAccessControl(path, AccessControlSections.Owner | AccessControlSections.Access);
            SecurityIdentifier owner = (SecurityIdentifier)security.GetOwner(typeof(SecurityIdentifier));
            if (!owner.Equals(current) || !security.AreAccessRulesProtected) throw new InvalidOperationException();
            AuthorizationRuleCollection rules = security.GetAccessRules(true, false, typeof(SecurityIdentifier));
            if (rules.Count != 2) throw new InvalidOperationException();
            HashSet<string> expected = new HashSet<string>(new[] { current.Value, system.Value }, StringComparer.Ordinal);
            InheritanceFlags inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
            foreach (FileSystemAccessRule rule in rules)
            {
                SecurityIdentifier sid = (SecurityIdentifier)rule.IdentityReference;
                if (rule.IsInherited || rule.AccessControlType != AccessControlType.Allow ||
                    rule.FileSystemRights != FileSystemRights.FullControl || rule.InheritanceFlags != inheritance ||
                    rule.PropagationFlags != PropagationFlags.None || !expected.Remove(sid.Value))
                    throw new InvalidOperationException();
            }
            if (expected.Count != 0) throw new InvalidOperationException();
            return security.GetSecurityDescriptorSddlForm(AccessControlSections.Owner | AccessControlSections.Access);
        }

        private static void SecureDirectory(string raw)
        {
            string path = CanonicalPath(raw);
            ReadIdentity(path, true);
            SecurityIdentifier current = CurrentUserSid();
            Directory.SetAccessControl(path, PrivateDirectorySecurity(path, current));
            VerifyPrivateDirectory(path);
            WriteOk();
        }

        private static void InspectPrivateDirectory(string raw)
        {
            WriteDescriptor(VerifyPrivateDirectory(raw));
        }

        private static void WriteDescriptor(string descriptor)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(descriptor);
            string digest;
            using (SHA256 sha = SHA256.Create())
            {
                digest = String.Concat(sha.ComputeHash(bytes).Select(value => value.ToString("x2")));
            }
            Console.Out.WriteLine("{\"ok\":true,\"descriptor_sha256\":\"" + digest + "\"}");
        }

        private static string JsonString(string value)
        {
            StringBuilder output = new StringBuilder("\"");
            foreach (char character in value)
            {
                if (character == '\\' || character == '\"') output.Append('\\').Append(character);
                else if (character < 0x20) output.Append("\\u").Append(((int)character).ToString("x4"));
                else output.Append(character);
            }
            return output.Append('\"').ToString();
        }

        private static void ListPrinters()
        {
            List<string> names = new List<string>();
            foreach (string name in PrinterSettings.InstalledPrinters) names.Add(name);
            names.Sort(StringComparer.Ordinal);
            Console.Out.WriteLine("{\"ok\":true,\"printers\":[" + String.Join(",", names.Select(JsonString)) + "]}");
        }

        private static byte[] ReadBoundedInput()
        {
            using (MemoryStream output = new MemoryStream())
            {
                byte[] buffer = new byte[8192];
                Stream input = Console.OpenStandardInput();
                int read;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    if (output.Length + read > MaximumPrintBytes) throw new InvalidOperationException();
                    output.Write(buffer, 0, read);
                }
                if (output.Length == 0) throw new InvalidOperationException();
                return output.ToArray();
            }
        }

        private static void PrintRaw(string queue)
        {
            if (String.IsNullOrWhiteSpace(queue) || queue.Length > 256 || queue.Any(Char.IsControl))
                throw new InvalidOperationException();
            byte[] bytes = ReadBoundedInput();
            IntPtr printer;
            if (!OpenPrinter(queue, out printer, IntPtr.Zero)) throw new InvalidOperationException();
            uint job = 0;
            bool accepted = false;
            try
            {
                DocInfo document = new DocInfo { DocumentName = "Laundry Desk", OutputFile = null, DataType = "RAW" };
                job = StartDocPrinter(printer, 1, ref document);
                if (job == 0) throw new InvalidOperationException();
                uint written;
                if (!WritePrinter(printer, bytes, (uint)bytes.Length, out written) || written != bytes.Length)
                    throw new PrintSubmissionUncertainException();
                uint completedJob = job;
                if (!EndDocPrinter(printer)) throw new PrintSubmissionUncertainException();
                job = 0;
                accepted = true;
                Console.Out.WriteLine("{\"ok\":true,\"job_id\":" + completedJob.ToString() + ",\"bytes_written\":" + bytes.Length.ToString() + "}");
            }
            catch (PrintSubmissionUncertainException)
            {
                throw;
            }
            catch
            {
                if (job != 0 || accepted) throw new PrintSubmissionUncertainException();
                throw;
            }
            finally
            {
                if (job != 0) AbortPrinter(printer);
                ClosePrinter(printer);
            }
        }

        private static void WriteOk()
        {
            Console.Out.WriteLine("{\"ok\":true}");
        }
    }
}
