!macro customInit
  nsExec::ExecToLog 'taskkill /F /T /IM "Hongfa Laundry.exe"'
  nsExec::ExecToLog 'taskkill /F /T /IM "宏发洗衣店.exe"'
  nsExec::ExecToLog 'taskkill /F /T /IM "laundry-desk.exe"'
  Sleep 1200
!macroend
