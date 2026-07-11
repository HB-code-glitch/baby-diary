# 빌드 후 바탕화면 바로가기를 최신 포터블 exe로 갱신
$release = Join-Path $PSScriptRoot '..\release'
$exe = Get-ChildItem $release -Filter 'Baby Diary*.exe' |
  Where-Object { $_.Name -notlike '*Setup*' } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $exe) { Write-Host '[shortcut] portable exe not found - skipped'; exit 0 }
$desktop = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut((Join-Path $desktop 'Baby Diary.lnk'))
$sc.TargetPath = $exe.FullName
$sc.WorkingDirectory = $exe.DirectoryName
$sc.Description = 'Baby Diary - 가족 육아 기록'
$sc.Save()
Write-Host "[shortcut] desktop shortcut -> $($exe.Name)"
