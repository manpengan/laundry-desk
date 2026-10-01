import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnvironment } from "./lifecycle-environment.mjs";

test(
  "task security accepts only the bound user and protected scheduler trustees",
  { skip: process.platform !== "win32", timeout: 90000 },
  async () => {
    const script = `
      $ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
      $errors=$null; $tokens=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile($env:LAUNDRY_PS_TASK_SECURITY_FILE,[ref]$tokens,[ref]$errors)
      if ($errors.Count -ne 0) { throw 'TASK_SECURITY_SYNTAX_INVALID' }
      $functions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-TaskSecurityDescriptor'},$true))
      if ($functions.Count -ne 1) { throw 'TASK_SECURITY_FUNCTION_MISSING' }
      . ([scriptblock]::Create($functions[0].Extent.Text))
      function Assert-Rejected {
        param([scriptblock]$Check, [string]$CaseName)
        try { & $Check } catch {
          if ($_.Exception.Message -eq 'WINDOWS_COMPANION_TASK_SECURITY_INVALID') { return }
          throw
        }
        throw ('TASK_SECURITY_UNEXPECTED_ACCEPTANCE_'+$CaseName)
      }
      $sid='S-1-5-21-100-200-300-1001'
      $strict='O:'+$sid+'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;'+$sid+')'
      if (-not (Assert-TaskSecurityDescriptor $strict $sid)) { throw 'TASK_SECURITY_STRICT_REJECTED' }
      if (-not (Assert-TaskSecurityDescriptor ($strict.Replace('FA','0x1f01ff')) $sid)) { throw 'TASK_SECURITY_CANONICAL_MASK_REJECTED' }
      $legacy='O:BAG:S-1-5-21-100-200-300-513D:(A;ID;0x1f019f;;;BA)(A;ID;0x1f019f;;;SY)(A;ID;FA;;;BA)(A;;FR;;;'+$sid+')'
      if (Assert-TaskSecurityDescriptor $legacy $sid -AllowLegacy) { throw 'TASK_SECURITY_LEGACY_UNCHANGED' }
      Assert-Rejected { Assert-TaskSecurityDescriptor $legacy $sid } 'LEGACY_STRICT'
      foreach ($case in @(
        @{Name='OWNER_SYSTEM'; Sddl=$strict.Replace('O:'+$sid,'O:SY')}
        @{Name='MISSING_SYSTEM'; Sddl=$strict.Replace('(A;;FA;;;SY)','')}
        @{Name='UNKNOWN_TRUSTEE'; Sddl=$strict.Replace('(A;;FA;;;BA)','(A;;FA;;;BU)')}
        @{Name='DENY_ACE'; Sddl=$strict.Replace('(A;;FA;;;BA)','(D;;FA;;;BA)')}
        @{Name='CONTAINER_INHERIT'; Sddl=$strict.Replace('(A;;FA;;;BA)','(A;CI;FA;;;BA)')}
        @{Name='EXECUTE_MASK'; Sddl=$strict.Replace('(A;;FA;;;BA)','(A;;GX;;;BA)')}
        @{Name='GENERIC_ALL_MASK'; Sddl=$strict.Replace('(A;;FA;;;BA)','(A;;0x10000000;;;BA)')}
        @{Name='OBJECT_ACE'; Sddl=$strict.Replace('(A;;FA;;;BA)','(OA;;FA;11111111-1111-1111-1111-111111111111;;BA)')}
        @{Name='CALLBACK_ACE'; Sddl=$strict.Replace('(A;;FA;;;BA)','(XA;;FA;;;BA)')}
        @{Name='NULL_DACL'; Sddl=('O:'+$sid+'D:NO_ACCESS_CONTROL')}
        @{Name='MALFORMED'; Sddl='not a descriptor'}
        @{Name='OVERSIZED'; Sddl=('x'*8193)}
      )) { Assert-Rejected { Assert-TaskSecurityDescriptor $case.Sddl $sid -AllowLegacy } $case.Name }
      $unprotected=$strict.Replace('D:P','D:')
      if (Assert-TaskSecurityDescriptor $unprotected $sid -AllowLegacy) { throw 'TASK_SECURITY_LEGACY_PROTECTION_UNCHANGED' }
      Assert-Rejected { Assert-TaskSecurityDescriptor $unprotected $sid } 'UNPROTECTED_STRICT'
      $duplicate=$strict+'(A;;FA;;;BA)'
      Assert-Rejected { Assert-TaskSecurityDescriptor $duplicate $sid } 'DUPLICATE_STRICT'
      $inherited=$strict.Replace('(A;;FA;;;BA)','(A;ID;FA;;;BA)')
      Assert-Rejected { Assert-TaskSecurityDescriptor $inherited $sid } 'INHERITED_STRICT'
      [Console]::WriteLine('TASK_SECURITY_ASSERTIONS_PASSED')
    `;
    const result = await promisify(execFile)(
      join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        env: {
          ...cleanEnvironment(),
          LAUNDRY_PS_TASK_SECURITY_FILE: fileURLToPath(
            new URL("lifecycle-host.ps1", import.meta.url),
          ),
        },
        windowsHide: true,
        // Leave room for Windows PowerShell startup and the AST walk on busy CI hosts.
        timeout: 60000,
        maxBuffer: 65536,
      },
    );
    assert.equal(result.stdout.trim(), "TASK_SECURITY_ASSERTIONS_PASSED");
    assert.equal(result.stderr, "");
  },
);
