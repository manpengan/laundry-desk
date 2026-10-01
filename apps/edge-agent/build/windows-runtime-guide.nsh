!macro customInstall
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME} 本地服务安装说明.lnk" "$SYSDIR\notepad.exe" '$"$INSTDIR\resources\windows-runtime-guide.txt$"'
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\${PRODUCT_NAME} 本地服务安装说明.lnk"
!macroend

!macro customFinishPage
  !define MUI_FINISHPAGE_TEXT "柜台已安装。首次使用前，请打开同批次 Runtime 安装与维护入口，选择安装本地服务，再启动柜台。卸载柜台会保留本地服务及数据库。"
  !define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\resources\windows-runtime-guide.txt"
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "查看本地服务安装说明"
  !insertmacro MUI_PAGE_FINISH
!macroend
