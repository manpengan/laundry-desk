# Windows field helper: send raw .bin to a USB/COM printer.
#
# ★ Prefer Node on Windows PowerShell 5.1:
#   node send/send-raw.mjs --file out\xp58-receipt.bin --target COM3
#
# -Port via System.IO.File.Open on COM often FAILS under Windows PowerShell 5.1
# (access denied / invalid handle). Use:
#   1) Node send-raw.mjs  (recommended)
#   2) -PrinterName with Generic/Text Only RAW share
#   3) pwsh 7+ if you insist on -Port
#
# Examples:
#   powershell -File .\send\send-windows.ps1 -File .\out\xp58-receipt.bin -PrinterName "XP-58"
#   pwsh -File .\send\send-windows.ps1 -File .\out\xp58-receipt.bin -Port COM3
#   powershell -File .\send\send-windows.ps1 -File .\out\gp3120-sticker-compact.bin -Tcp "192.168.1.50:9100"

param(
  [Parameter(Mandatory = $true)][string]$File,
  [string]$Port,
  [string]$PrinterName,
  [string]$Tcp
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $File)) { throw "file not found: $File" }
$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $File))
Write-Host "bytes=$($bytes.Length) file=$File"
Write-Host "PSVersion=$($PSVersionTable.PSVersion) Edition=$($PSVersionTable.PSEdition)"

if ($Tcp) {
  $hostPort = $Tcp.Split(":")
  $client = New-Object System.Net.Sockets.TcpClient($hostPort[0], [int]$hostPort[1])
  $stream = $client.GetStream()
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Close()
  $client.Close()
  Write-Host "tcp send ok"
  exit 0
}

if ($Port) {
  $ver = $PSVersionTable.PSVersion
  if ($ver.Major -lt 7) {
    Write-Host @"
ERROR: -Port is unreliable on Windows PowerShell 5.1 (COM open often denied).
Use one of:
  node send/send-raw.mjs --file `"$File`" --target $Port
  powershell -File .\send\send-windows.ps1 -File `"$File`" -PrinterName `"<share>`"
  pwsh 7+  -File .\send\send-windows.ps1 -File `"$File`" -Port $Port
"@
    exit 2
  }
  $path = if ($Port -match '^COM\d+$') { "\\.\$Port" } else { $Port }
  $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Write)
  $fs.Write($bytes, 0, $bytes.Length)
  $fs.Close()
  Write-Host "port send ok path=$path"
  exit 0
}

if ($PrinterName) {
  # RAW job via Winspool — requires printer driver set to "Generic / Text Only" or RAW datatype.
  $tmp = Join-Path $env:TEMP ("laundry-m0-3-" + [guid]::NewGuid().ToString() + ".bin")
  [System.IO.File]::WriteAllBytes($tmp, $bytes)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "cmd.exe"
  $psi.Arguments = "/c copy /b `"$tmp`" `"\\localhost\$PrinterName`""
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.WaitForExit()
  Remove-Item $tmp -Force
  if ($p.ExitCode -ne 0) { throw "copy to printer failed: $($p.StandardError.ReadToEnd())" }
  Write-Host "printer share send ok name=$PrinterName"
  exit 0
}

throw "specify -PrinterName (preferred) or -Tcp; -Port only on pwsh7+. Prefer: node send/send-raw.mjs"
