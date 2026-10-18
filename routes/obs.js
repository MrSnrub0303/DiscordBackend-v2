const { app } = require("../app");

// GET /api/obs/setup-bat  (serves a .bat that configures OBS WebSocket + browser dock)
// The bat runs a base64-encoded PowerShell script so no cmd.exe escaping is needed.
function buildObsSetupBat(dashboardUrl, serverBaseUrl) {
  // PowerShell script — written as plain JS template literals.
  // In template literals: \` → backtick (used for PS escape seqs like `r`n),
  //                       \\ → backslash (used for regex \[ and path separators).
  const psLines = [
    // OBS running check — covers 64-bit, 32-bit, and generic obs-studio process names
    `if (Get-Process -Name 'obs64','obs32','obs-studio' -ErrorAction SilentlyContinue) {`,
    `  Write-Host '[WARNING] OBS Studio is running. Close it first, then run this script again.' -ForegroundColor Yellow`,
    `  $null = Read-Host 'Press Enter to exit'`,
    `  exit 1`,
    `}`,
    // UTF-8 WITHOUT BOM — OBS's INI parser breaks if a BOM is present.
    // [Text.Encoding]::UTF8 includes BOM, so we create the no-BOM variant explicitly.
    `$utf8 = New-Object System.Text.UTF8Encoding $false`,
    `$ProgressPreference = 'SilentlyContinue'`,
    ``,
    `# ── Step 1: Download overlay assets ──────────────────────────────────`,
    `$serverUrl   = '${serverBaseUrl}'`,
    `$localAssets = Join-Path $env:USERPROFILE 'Downloads\\Overlay Assets 2.1'`,
    `if (-not (Test-Path $localAssets)) { New-Item -ItemType Directory -Path $localAssets | Out-Null }`,
    `Write-Host '[1/6] Downloading overlay assets...'`,
    `try {`,
    `  # Use Invoke-WebRequest + ConvertFrom-Json with explicit accumulation to avoid`,
    `  # PS 5.1's single-element array unwrapping quirk with Invoke-RestMethod`,
    `  $rawJson  = (Invoke-WebRequest -Uri "$serverUrl/api/obs/drive-manifest" -UseBasicParsing -ErrorAction Stop).Content`,
    `  $manifest = @()`,
    `  foreach ($item in ($rawJson | ConvertFrom-Json)) { $manifest += $item }`,
    `  Write-Host "  Found $($manifest.Count) file(s) on Drive." -ForegroundColor DarkGray`,
    `  foreach ($file in $manifest) {`,
    `    $fileName    = [string]$file.name`,
    `    $downloadUrl = [string]$file.downloadUrl`,
    `    $dest        = Join-Path $localAssets $fileName`,
    `    $needsDl     = (-not (Test-Path $dest)) -or ((Get-Item $dest).Length -ne [long]"$($file.size)")`,
    `    if ($needsDl) {`,
    `      Write-Host "  Downloading $fileName..." -ForegroundColor Yellow`,
    `      Invoke-WebRequest -Uri $downloadUrl -OutFile $dest -UseBasicParsing -ErrorAction Stop`,
    `      $localSize = (Get-Item $dest).Length`,
    `      $driveSize = [long]"$($file.size)"`,
    `      if ($driveSize -gt 0 -and $localSize -ne $driveSize) {`,
    `        Remove-Item $dest -Force -ErrorAction SilentlyContinue`,
    `        throw "Download of $fileName failed (got $localSize B, expected $driveSize B). Try re-running the setup script."`,
    `      }`,
    `      Write-Host "  [OK] $fileName" -ForegroundColor Green`,
    `    } else {`,
    `      Write-Host "  [--] $fileName already up-to-date." -ForegroundColor DarkGray`,
    `    }`,
    `  }`,
    `  Write-Host '[OK] Assets ready.' -ForegroundColor Green`,
    `} catch {`,
    `  Write-Host "[FAIL] Asset download: $_" -ForegroundColor Red`,
    `  $null = Read-Host 'Press Enter to exit'; exit 1`,
    `}`,
    ``,
    `# ── Step 2: Install font ─────────────────────────────────────────────`,
    `Write-Host '[2/6] Installing font...'`,
    `$fontSrc = Join-Path $localAssets 'TrajanPro-Bold.otf'`,
    `if (Test-Path $fontSrc) {`,
    `  try {`,
    `    Copy-Item $fontSrc 'C:\\Windows\\Fonts\\TrajanPro-Bold.otf' -Force`,
    `    $regPath = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'`,
    `    New-ItemProperty -Path $regPath -Name 'Trajan Pro Bold (OpenType)' -Value 'TrajanPro-Bold.otf' -PropertyType String -Force -ErrorAction SilentlyContinue | Out-Null`,
    `    Write-Host '[OK] TrajanPro-Bold.otf installed.' -ForegroundColor Green`,
    `  } catch {`,
    `    Write-Host "[WARN] Font install failed: $_" -ForegroundColor Yellow`,
    `  }`,
    `} else {`,
    `  Write-Host '[WARN] TrajanPro-Bold.otf not found in assets — skipped.' -ForegroundColor Yellow`,
    `}`,
    ``,
    `# ── Step 3: Patch Overlay_21.json + copy to OBS scenes ───────────────`,
    `Write-Host '[3/6] Importing OBS scene collection...'`,
    `$jsonSrc = Join-Path $localAssets 'Overlay_21.json'`,
    `if (Test-Path $jsonSrc) {`,
    `  try {`,
    `    $uname     = $env:USERNAME`,
    `    $json      = [IO.File]::ReadAllText($jsonSrc)`,
    `    $json      = $json -replace 'Joshua', $uname`,
    `    # bounds_type 2 = SCALE_INNER: AoE3 in borderless fullscreen on 4K presents at native display res — without bounds the canvas clips to top-left`,
    `    try {`,
    `      $gcUuid = '87811d7c-48fe-4d09-84c8-621a99a21389'`,
    `      $parts  = $json -split [regex]::Escape($gcUuid), 2`,
    `      if ($parts.Count -eq 2) {`,
    `        $pre  = $parts[0]`,
    `        $pre  = [regex]::Replace($pre, '(?s)(.*"bounds_type":\\s*)\\d+', '\${1}2')`,
    `        $pre  = [regex]::Replace($pre, '(?s)(.*"bounds":\\s*\\{\\s*"x":\\s*)[\\d.]+([^}]*?"y":\\s*)[\\d.]+', '\${1}1920.0\${2}1080.0')`,
    `        $json = $pre + $gcUuid + $parts[1]`,
    `        Write-Host '  DPI fix: AoE3DE bounds set to SCALE_INNER 1920x1080.' -ForegroundColor DarkGray`,
    `      } else { Write-Host '  [WARN] Game capture UUID not found in scene JSON — bounds patch skipped.' -ForegroundColor Yellow }`,
    `    } catch { Write-Host "  [WARN] Game capture bounds patch skipped: $_" -ForegroundColor Yellow }`,
    `    $scenesDir = Join-Path $env:APPDATA 'obs-studio\\basic\\scenes'`,
    `    if (-not (Test-Path $scenesDir)) { New-Item -ItemType Directory -Path $scenesDir | Out-Null }`,
    `    [IO.File]::WriteAllText((Join-Path $scenesDir 'Overlay_21.json'), $json, $utf8)`,
    `    Write-Host "[OK] Overlay_21.json imported (username: $uname)." -ForegroundColor Green`,
    `  } catch {`,
    `    Write-Host "[FAIL] Scene import: $_" -ForegroundColor Red`,
    `  }`,
    `} else {`,
    `  Write-Host '[WARN] Overlay_21.json not in assets — scene import skipped.' -ForegroundColor Yellow`,
    `}`,
    ``,
    `$obsRoot   = Join-Path $env:APPDATA 'obs-studio'`,
    `$globalIni = Join-Path $obsRoot 'global.ini'`,
    `if (-not (Test-Path $globalIni)) {`,
    `  Write-Host '[ERROR] OBS global.ini not found. Install OBS and launch it once first.' -ForegroundColor Red`,
    `  $null = Read-Host 'Press Enter to exit'`,
    `  exit 1`,
    `}`,
    ``,
    `# ── Step 4: WebSocket settings + active profile ──────────────────────`,
    `Write-Host '[4/6] Configuring OBS WebSocket and active profile...'`,
    `try {`,
    `  $txt = [IO.File]::ReadAllText($globalIni)`,
    `  # Remove existing WebSocket block (will be re-appended below)`,
    `  $txt = [regex]::Replace($txt, '(?ms)^\\[OBSWebSocket\\].*?(?=\\r?\\n\\[|\\z)', '')`,
    `  # OBS 28+ stores the active profile in [Basic] as Profile/ProfileDir, not [General] CurrentProfile`,
    `  $basicPat = '(?ms)^\\[Basic\\].*?(?=\\r?\\n\\[|\\z)'`,
    `  foreach ($kv in @('Profile=ESOC Profile','ProfileDir=ESOC Profile','SceneCollection=Overlay 2.1','SceneCollectionFile=Overlay_21')) {`,
    `    $k = $kv.Split('=')[0]`,
    `    if ($txt -match "(?m)^$([regex]::Escape($k))=") {`,
    `      $txt = [regex]::Replace($txt, "(?m)^$([regex]::Escape($k))=.*$", $kv)`,
    `    } else {`,
    `      $bM = [regex]::Match($txt, $basicPat)`,
    `      if ($bM.Success) { $txt = $txt.Replace($bM.Value, $bM.Value.TrimEnd() + "\`r\`n$kv") }`,
    `      else              { $txt = $txt.TrimEnd() + "\`r\`n\`r\`n[Basic]\`r\`n$kv\`r\`n" }`,
    `    }`,
    `  }`,
    `  $block = "\`r\`n[OBSWebSocket]\`r\`nServerEnabled=true\`r\`nServerPort=4455\`r\`nAuthRequired=true\`r\`nServerPassword=RoyplmJZZXNdwUzL\`r\`n"`,
    `  [IO.File]::WriteAllText($globalIni, $txt.TrimEnd() + $block, $utf8)`,
    `  # OBS 30+ also stores active profile in user.ini — write there too if it exists`,
    `  $userIniProf = Join-Path $obsRoot 'user.ini'`,
    `  if (Test-Path $userIniProf) {`,
    `    $utxt = [IO.File]::ReadAllText($userIniProf)`,
    `    $ubasicPat = '(?ms)^\\[Basic\\].*?(?=\\r?\\n\\[|\\z)'`,
    `    foreach ($kv in @('Profile=ESOC Profile','ProfileDir=ESOC Profile','SceneCollection=Overlay 2.1','SceneCollectionFile=Overlay_21')) {`,
    `      $k = $kv.Split('=')[0]`,
    `      if ($utxt -match "(?m)^$([regex]::Escape($k))=") {`,
    `        $utxt = [regex]::Replace($utxt, "(?m)^$([regex]::Escape($k))=.*$", $kv)`,
    `      } else {`,
    `        $ubM = [regex]::Match($utxt, $ubasicPat)`,
    `        if ($ubM.Success) { $utxt = $utxt.Replace($ubM.Value, $ubM.Value.TrimEnd() + "\`r\`n$kv") }`,
    `        else              { $utxt = $utxt.TrimEnd() + "\`r\`n\`r\`n[Basic]\`r\`n$kv\`r\`n" }`,
    `      }`,
    `    }`,
    `    [IO.File]::WriteAllText($userIniProf, $utxt, $utf8)`,
    `    Write-Host '  Active profile also written to user.ini (OBS 30+).' -ForegroundColor DarkGray`,
    `  }`,
    `  Write-Host '[OK] WebSocket configured. Active profile set to ESOC Profile.' -ForegroundColor Green`,
    `} catch {`,
    `  Write-Host "[FAIL] Could not update global.ini: $_" -ForegroundColor Red`,
    `  $null = Read-Host 'Press Enter to exit'; exit 1`,
    `}`,
    ``,
    `$url       = '${dashboardUrl}'`,
    `# Dock definition — uuid ties the dock to the saved DockState layout blob`,
    `$newDocks  = "[{""title"":""ESOC Docker"",""url"":""$url"",""uuid"":""ecdddb0891b848d8b4e70fbf1d59ec5e""}]"`,
    `# DockState blob encodes the full window layout (dock positions, sizes, visibility).`,
    `# Captured from the host machine after the ESOC Docker was positioned correctly.`,
    `$dockState = 'AAAA/wAAAAD9AAAAAwAAAAAAAAE/AAADvPwCAAAAAvsAAAAUAHMAYwBlAG4AZQBzAEQAbwBjAGsBAAAAGwAAALcAAACMAP////wAAADWAAADAQAAAFAA////+gAAAAABAAAAB/sAAAAwAEUAUwBPAEMAIABEAG8AYwBrAGUAcgBfAGUAeAB0AHIAYQBCAHIAbwB3AHMAZQByAQAAAAD/////AAAAUAD////7AAAAGgBfAGUAeAB0AHIAYQBCAHIAbwB3AHMAZQByAQAAAAD/////AAAAAAAAAAD7AAAALgBFAFMATwBDACAAQQBkAG0AaQBuAF8AZQB4AHQAcgBhAEIAcgBvAHcAcwBlAHIAAAAAAP////8AAAAAAAAAAPsAAAAsAEUAUwBPAEMAIABEAG8AYwBrAF8AZQB4AHQAcgBhAEIAcgBvAHcAcwBlAHIAAAAAAP////8AAAAAAAAAAPsAAAAWAHMAbwB1AHIAYwBlAHMARABvAGMAawAAAAAA/////wAAAJgA////+wAAAB4AdAByAGEAbgBzAGkAdABpAG8AbgBzAEQAbwBjAGsAAAAAAP////8AAACCAP////sAAAAmAG8AYgBzAC0AbQB1AGwAdABpAC0AcgB0AG0AcAAtAGQAbwBjAGsBAAAAAP////8AAAAAAAAAAAAAAAEAAAFIAAADvPwCAAAABvsAAAASAG0AaQB4AGUAcgBEAG8AYwBrAQAAABsAAALcAAABBQD////7AAAAGABjAG8AbgB0AHIAbwBsAHMARABvAGMAawEAAAL7AAAA3AAAANgA////+wAAABQAdAB3AGkAdABjAGgAQwBoAGEAdAEAAAFgAAACdwAAAAAAAAAA+wAAABQAdAB3AGkAdABjAGgASQBuAGYAbwL///iyAAAASQAAASwAAAKK+wAAABYAdAB3AGkAdABjAGgAUwB0AGEAdABzAv//+9wAAAGHAAAAyAAAAPr7AAAAFAB0AHcAaQB0AGMAaABGAGUAZQBkAv//+OQAAABcAAABLAAAAooAAAADAAAHgAAAASD8AQAAAAH7AAAAEgBzAHQAYQB0AHMARABvAGMAawL///kWAAABswAAArwAAADeAAAE8QAAA7wAAAAEAAAABAAAAAgAAAAI/AAAAAA='`,
    ``,
    `# Step 5: Write ExtraBrowserDocks + DockState to global.ini AND user.ini`,
    `Write-Host '[5/6] Writing dock definition and layout to OBS ini file(s)...'`,
    `$iniTargets = [System.Collections.Generic.List[string]]::new()`,
    `$iniTargets.Add($globalIni)`,
    `$userIni = Join-Path $obsRoot 'user.ini'`,
    `if (Test-Path $userIni) { $iniTargets.Add($userIni); Write-Host '  user.ini detected.' -ForegroundColor DarkGray }`,
    `foreach ($iniFile in $iniTargets) {`,
    `  $label = Split-Path $iniFile -Leaf`,
    `  Write-Host "  [$label]" -ForegroundColor DarkGray`,
    `  try {`,
    `    $txt = [IO.File]::ReadAllText($iniFile)`,
    `    # Strip keys that will be re-injected with correct values`,
    `    $txt = [regex]::Replace($txt, '(?m)^ExtraBrowserDocks=.*\r?\n?', '')`,
    `    $txt = [regex]::Replace($txt, '(?m)^DockState=.*\r?\n?', '')`,
    `    $txt = [regex]::Replace($txt, '(?m)^DocksLocked=.*\r?\n?', '')`,
    `    # Inject all three keys into [BasicWindow], creating the section if missing`,
    `    $inject = "\`r\`nExtraBrowserDocks=$newDocks\`r\`nDockState=$dockState\`r\`nDocksLocked=true"`,
    `    $bwPat = '(?ms)^\\[BasicWindow\\].*?(?=\\r?\\n\\[|\\z)'`,
    `    $bwM   = [regex]::Match($txt, $bwPat)`,
    `    if ($bwM.Success) {`,
    `      $txt = $txt.Replace($bwM.Value, $bwM.Value.TrimEnd() + $inject)`,
    `    } else {`,
    `      $txt = $txt.TrimEnd() + "\`r\`n\`r\`n[BasicWindow]" + $inject + "\`r\`n"`,
    `    }`,
    `    [IO.File]::WriteAllText($iniFile, $txt, $utf8)`,
    `    Write-Host "    [OK] ExtraBrowserDocks + DockState + DocksLocked written." -ForegroundColor Green`,
    `  } catch {`,
    `    Write-Host "    [FAIL] $label : $_" -ForegroundColor Red`,
    `  }`,
    `}`,
    ``,
    `# Step 6: Create / configure ESOC Profile (1920x1080@60fps, encoder, dock)`,
    `Write-Host '[6/6] Configuring ESOC Profile...'`,
    `$profilesDir = Join-Path $obsRoot 'basic\\profiles'`,
    `if (-not (Test-Path $profilesDir)) { New-Item -ItemType Directory -Path $profilesDir | Out-Null }`,
    `# Detect GPU and select matching OBS encoder IDs`,
    `$gpuName = (Get-WmiObject -Class Win32_VideoController |`,
    `  Where-Object { $_.Name -notmatch 'Microsoft Basic Display' } |`,
    `  Select-Object -First 1).Name`,
    `if     ($gpuName -match 'NVIDIA')                             { $simpleEnc = 'nvenc';        $advEnc = 'jim_nvenc'     }`,
    `elseif ($gpuName -match 'AMD|Radeon|Advanced Micro Devices')  { $simpleEnc = 'amd_amf_h264'; $advEnc = 'amd_amf_h264' }`,
    `elseif ($gpuName -match 'Intel')                              { $simpleEnc = 'obs_qsv11';    $advEnc = 'obs_qsv11'    }`,
    `else                                                          { $simpleEnc = 'obs_x264';     $advEnc = 'obs_x264'     }`,
    `Write-Host "  GPU: $gpuName -> Encoder: $simpleEnc" -ForegroundColor DarkGray`,
    `$esocProfileDir = Join-Path $profilesDir 'ESOC Profile'`,
    `if (-not (Test-Path $esocProfileDir)) {`,
    `  New-Item -ItemType Directory -Path $esocProfileDir | Out-Null`,
    `  Write-Host '  Created new ESOC Profile directory.' -ForegroundColor DarkGray`,
    `}`,
    `try {`,
    `  $basicIni   = Join-Path $esocProfileDir 'basic.ini'`,
    `  $basicLines = @(`,
    `    '[General]', 'Name=ESOC Profile', '',`,
    `    '[Output]', 'Mode=Simple', 'FilenameFormatting=%CCYY-%MM-%DD %hh-%mm-%ss',`,
    `    'DelayEnable=false', 'DelaySec=20', 'DelayPreserve=true', 'Reconnect=true',`,
    `    'RetryDelay=2', 'MaxRetries=25', 'BindIP=default', 'NewSocketLoopEnable=false',`,
    `    'LowLatencyEnable=false', 'IPFamily=IPv4+IPv6', '',`,
    `    '[Stream1]', 'IgnoreRecommended=false', 'MultitrackVideoMaximumAggregateBitrateAuto=true',`,
    `    'MultitrackVideoMaximumVideoTracksAuto=true', 'EnableMultitrackVideo=false', '',`,
    `    '[SimpleOutput]', 'VBitrate=6000', 'ABitrate=320'`,
    `  )`,
    `  if ($simpleEnc -eq 'nvenc') { $basicLines += 'NVENCPreset2=p5' }`,
    `  $basicLines += @(`,
    `    'RecFormat2=mp4', 'RecQuality=HQ', 'RecRB=false', 'RecRBTime=10', 'RecRBSize=550',`,
    `    'RecRBPrefix=Replay', 'StreamAudioEncoder=aac', 'RecAudioEncoder=aac', 'RecTracks=1',`,
    `    "StreamEncoder=$simpleEnc", "RecEncoder=$simpleEnc", 'UseAdvanced=false', '',`,
    `    '[AdvOut]', 'ApplyServiceSettings=true', 'UseRescale=false', 'TrackIndex=1', 'VodTrackIndex=2',`,
    `    "Encoder=$advEnc", 'RecType=Standard', "RecFilePath=$env:USERPROFILE\\Videos",`,
    `    'RecFormat2=mkv', 'RecUseRescale=false', 'RecTracks=1', 'RecEncoder=none',`,
    `    'FLVTrack=1', 'FFOutputToFile=true', "FFFilePath=$env:USERPROFILE\\Videos",`,
    `    'FFVBitrate=2500', 'FFVGOPSize=250', 'FFUseRescale=false', 'FFIgnoreCompat=false',`,
    `    'FFABitrate=160', 'FFAudioMixes=1', 'Track1Bitrate=160', 'Track2Bitrate=160',`,
    `    'Track3Bitrate=160', 'Track4Bitrate=160', 'Track5Bitrate=160', 'Track6Bitrate=160',`,
    `    'RecSplitFileTime=15', 'RecSplitFileSize=2048', 'RecRB=false', 'RecRBTime=20',`,
    `    'RecRBSize=512', 'AudioEncoder=ffmpeg_aac', 'RecAudioEncoder=ffmpeg_aac',`,
    `    'RecSplitFileType=Time', 'FFFormat=', 'FFFormatMimeType=', 'FFVEncoderId=0',`,
    `    'FFVEncoder=', 'FFAEncoderId=0', 'FFAEncoder=', 'StreamMultiTrackAudioMixes=1', 'FFExtension=mp4', '',`,
    `    '[Video]', 'BaseCX=1920', 'BaseCY=1080', 'OutputCX=1920', 'OutputCY=1080',`,
    `    'FPSType=0', 'FPSCommon=60', 'FPSInt=30', 'FPSNum=30', 'FPSDen=1',`,
    `    'ScaleType=bicubic', 'ColorFormat=NV12', 'ColorSpace=709', 'ColorRange=Partial',`,
    `    'SdrWhiteLevel=300', 'HdrNominalPeakLevel=1000', '',`,
    `    '[Audio]', 'MonitoringDeviceId=default', 'MonitoringDeviceName=Default',`,
    `    'SampleRate=48000', 'ChannelSetup=Stereo', 'MeterDecayRate=23.53', 'PeakMeterType=0', '',`,
    `    '[ExtraBrowserDocks]', 'ExtraBrowserDockCount=1', 'ExtraBrowserDock0Title=ESOC Docker',`,
    `    "ExtraBrowserDock0Url=$url", ''`,
    `  )`,
    `  $basicContent = $basicLines -join "\`r\`n"`,
    `  [IO.File]::WriteAllText($basicIni, $basicContent, $utf8)`,
    `  # Stream service (Restream.io, Autodetect server, ESOC stream key)`,
    `  $serviceJson = '{"type":"rtmp_common","settings":{"service":"Restream.io","protocol":"RTMP","server":"rtmp://live.restream.io/live","bwtest":false,"key":"re_9015438_eventefb46986a0b7402084c4488a00985c0a"}}'`,
    `  [IO.File]::WriteAllText((Join-Path $esocProfileDir 'service.json'), $serviceJson, $utf8)`,
    `  Write-Host "[OK] ESOC Profile: StreamEncoder=$simpleEnc, Restream.io key set, 1920x1080@60fps, 48kHz stereo, dock written." -ForegroundColor Green`,
    `} catch {`,
    `  Write-Host "[FAIL] ESOC Profile basic.ini: $_" -ForegroundColor Red`,
    `}`,
    ``,
    `# Diagnostic: show every OBS config file touched in the last 2 minutes`,
    `Write-Host ''`,
    `Write-Host '--- Files modified by this script ---' -ForegroundColor DarkCyan`,
    `Get-ChildItem -Path $obsRoot -Recurse -File -ErrorAction SilentlyContinue |`,
    `  Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-2) } |`,
    `  ForEach-Object { Write-Host "  $($_.FullName -replace [regex]::Escape($obsRoot),'%APPDATA%\\obs-studio')" -ForegroundColor DarkCyan }`,
    `Write-Host '---' -ForegroundColor DarkCyan`,
    ``,
    `Write-Host ''`,
    `Write-Host '==================================================='`,
    `Write-Host ' Setup complete! Reopen OBS.' -ForegroundColor Cyan`,
    `Write-Host ' ESOC Admin will appear in the Docks menu.' -ForegroundColor Cyan`,
    `Write-Host '==================================================='`,
  ];

  const psScript = psLines.join('\n');
  // Encode as UTF-16LE base64 (PowerShell -EncodedCommand format), then split into
  // 76-char lines so the bat can echo them to a temp file — bypasses cmd's 8191-char
  // line limit which the script now exceeds when passed as a single -EncodedCommand arg.
  const encoded  = Buffer.from(psScript, 'utf16le').toString('base64');
  const b64Lines = (encoded.match(/.{1,76}/g) || []).map(l => `  echo ${l}`);

  const batLines = [
    '@echo off',
    'net session >nul 2>&1',
    'if %errorlevel% neq 0 (',
    "  powershell -Command \"Start-Process -FilePath '%~f0' -Verb RunAs\"",
    '  exit /b',
    ')',
    'echo ===================================================',
    'echo  ESOC Full Overlay Setup',
    'echo ===================================================',
    'echo.',
    'set "TMPB64=%TEMP%\\esoc_obs_setup.b64"',
    'set "TMPPS=%TEMP%\\esoc_obs_setup.ps1"',
    '> "%TMPB64%" (',
    ...b64Lines,
    ')',
    `powershell -NoProfile -Command "$b=[Convert]::FromBase64String(([IO.File]::ReadAllText($env:TMPB64) -replace '\\s',''));[IO.File]::WriteAllText($env:TMPPS,[Text.Encoding]::Unicode.GetString($b))"`,
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%TMPPS%"',
    'del "%TMPB64%" 2>nul',
    'del "%TMPPS%" 2>nul',
    'echo.',
    'pause',
  ];
  return batLines.join('\r\n');
}

function handleObsSetupBatRequest(req, res) {
  const serverBase = process.env.SERVER_URL || 'https://discordbackend-v2.onrender.com';
  const defaultUrl = `${serverBase}/obs-dashboard`;
  const url = req.query.url ? decodeURIComponent(req.query.url) : defaultUrl;
  const bat = buildObsSetupBat(url, serverBase);
  res.setHeader("Content-Disposition", 'attachment; filename="Setup ESOC OBS Dashboard.bat"');
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(bat);
}
app.get("/api/obs/setup-bat", handleObsSetupBatRequest);
app.get("/obs/setup-bat",     handleObsSetupBatRequest);

const DRIVE_OVERLAY_FOLDER_ID = '1IOFHu65Km7-tMHXZZSDD0XzrQrBywkNl';

// GET /api/obs/drive-manifest — list files in the public overlay assets Drive folder
async function handleDriveManifest(req, res) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Google API key not configured on server' });
  try {
    const axios = require('axios');
    const resp = await axios.get('https://www.googleapis.com/drive/v3/files', {
      params: {
        q: `'${DRIVE_OVERLAY_FOLDER_ID}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
        fields: 'files(id,name,size,mimeType)',
        pageSize: 1000,
        key: apiKey,
      },
    });
    // Attach a direct download URL so the bat can download straight from Google
    // rather than proxying through this server (avoids timeout on large MP4s).
    const files = (resp.data.files || []).map(f => ({
      ...f,
      downloadUrl: `https://drive.usercontent.google.com/download?id=${f.id}&export=download&confirm=t&authuser=0`,
    }));
    res.json(files);
  } catch (err) {
    console.error('[Drive manifest]', err.response?.data || err.message);
    res.status(502).json({ error: 'Failed to fetch Drive manifest' });
  }
}
app.get('/api/obs/drive-manifest', handleDriveManifest);
app.get('/obs/drive-manifest',     handleDriveManifest);

// GET /api/obs/drive-download/:fileId — proxy a public Drive file download (key stays server-side)
async function handleDriveDownload(req, res) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Google API key not configured on server' });
  const { fileId } = req.params;
  if (!/^[\w-]+$/.test(fileId)) return res.status(400).json({ error: 'Invalid file ID' });
  try {
    const axios = require('axios');
    const driveResp = await axios.get(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      params: { alt: 'media', key: apiKey },
      responseType: 'stream',
    });
    res.setHeader('Content-Type', driveResp.headers['content-type'] || 'application/octet-stream');
    if (driveResp.headers['content-length']) {
      res.setHeader('Content-Length', driveResp.headers['content-length']);
    }
    driveResp.data.pipe(res);
  } catch (err) {
    console.error('[Drive download]', err.response?.data || err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Failed to download file from Drive' });
  }
}
app.get('/api/obs/drive-download/:fileId', handleDriveDownload);
app.get('/obs/drive-download/:fileId',     handleDriveDownload);
