export const WINDOWS_SCALE_SCRIPT = String.raw`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
try {
 $q=[Console]::In.ReadToEnd()|ConvertFrom-Json
 if($q.operation -eq 'ports'){
  $ports=@([IO.Ports.SerialPort]::GetPortNames()|Where-Object{$_ -cmatch '^COM([1-9][0-9]{0,2})$' -and [int]$_.Substring(3) -le 256}|Sort-Object -Unique|Select-Object -First 256)
  [Console]::Write((@{ports=$ports}|ConvertTo-Json -Compress));exit 0
 }
 if($q.operation -ne 'read' -or $q.port -cnotmatch '^COM([1-9][0-9]{0,2})$' -or
   [int]$q.port.Substring(3) -gt 256 -or $q.baud -notin @(1200,2400,4800,9600,19200,38400) -or
   $q.framing -notin @('8N1','7E1','7O1')){throw 'invalid'}
 if(@([IO.Ports.SerialPort]::GetPortNames()) -cnotcontains $q.port){throw 'missing'}
 $parity=if($q.framing -eq '7E1'){[IO.Ports.Parity]::Even}elseif($q.framing -eq '7O1'){[IO.Ports.Parity]::Odd}else{[IO.Ports.Parity]::None}
 $bits=if($q.framing -eq '8N1'){8}else{7}
 $port=[IO.Ports.SerialPort]::new($q.port,[int]$q.baud,$parity,$bits,[IO.Ports.StopBits]::One)
 $port.Handshake=[IO.Ports.Handshake]::None;$port.DtrEnable=$false;$port.RtsEnable=$false;$port.ReadTimeout=100
 try {
  $port.Open();$port.DiscardInBuffer();$clock=[Diagnostics.Stopwatch]::StartNew();$capture=''
  while($clock.ElapsedMilliseconds -lt 2500){
   $chunk=$port.ReadExisting();$capture+=$chunk
   if($capture.Length -gt 4096){throw 'overflow'}
   if($capture.EndsWith([string]::Concat([char]13,[char]10))){break}
   Start-Sleep -Milliseconds 20
  }
  [Console]::Write((@{capture=$capture}|ConvertTo-Json -Compress))
 }finally{$port.Dispose()}
}catch{[Console]::Error.Write('SCALE_READ_FAILED');exit 1}
`;
