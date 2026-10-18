const fsSync = require("fs");
const path = require("path");
const { app } = require("../app");
const ROOT_DIR = path.join(__dirname, "..");

// GET /api/coop/download/:campaignId/:actId/:levelId  (serves AoE3 scenario files)
// ?name=Breakout  →  looks for "Breakout COOP.age3Yscn" in coop-scenarios/
function handleDownloadRequest(req, res) {
  const { campaignId, actId, levelId } = req.params;
  if (!/^\d+$/.test(campaignId) || !/^\d+$/.test(actId) || !/^\d+$/.test(levelId)) {
    return res.status(400).json({ error: "Invalid parameters" });
  }
  const levelName = (req.query.name || '').replace(/[<>:"/\\|*\x00-\x1f]/g, '').trim();
  const filename  = levelName ? `${levelName} COOP.age3Yscn` : `${campaignId}act${actId}lvl${levelId}.age3Yscn`;
  const filePath  = path.join(ROOT_DIR, "coop-scenarios", filename);
  if (!fsSync.existsSync(filePath)) {
    return res.status(404).json({ error: "Scenario not yet available" });
  }
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/octet-stream");
  res.sendFile(filePath);
}
app.get("/api/coop/download/:campaignId/:actId/:levelId", handleDownloadRequest);
app.get("/coop/download/:campaignId/:actId/:levelId",     handleDownloadRequest);

// GET /api/coop/install/:campaignId/:actId/:levelId  (serves a .bat auto-installer)
function buildBatInstaller(scenarioFile, downloadUrl) {
  const lines = [
    '@echo off',
    'setlocal enabledelayedexpansion',
    `set "FILE_URL=${downloadUrl}"`,
    `set "FILE_NAME=${scenarioFile}"`,
    'set "BASE=%USERPROFILE%\\Games\\Age of Empires 3 DE"',
    'set "FOUND=0"',
    '',
    'if not exist "%BASE%\\" (',
    '    echo [ERROR] Age of Empires 3 DE folder not found.',
    '    echo Expected: %BASE%',
    '    echo Please ensure the game is installed.',
    '    goto :end',
    ')',
    '',
    'echo Scanning for AoE3 DE Steam profile folders...',
    'echo.',
    '',
    'for /D %%d in ("%BASE%\\*") do (',
    '    set "DNAME=%%~nxd"',
    '    set "ISNUM=1"',
    '    for /F "delims=0123456789" %%c in ("!DNAME!") do set "ISNUM=0"',
    '    rem Only process all-numeric folders with at least 10 digits (valid Steam IDs)',
    '    if "!ISNUM!"=="1" if not "!DNAME:~9,1!"=="" (',
    '        if exist "%%d\\Scenario\\" (',
    '            if exist "%%d\\Scenario\\%FILE_NAME%" (',
    '                echo [SKIP] Already installed:',
    '                echo        %%d\\Scenario\\%FILE_NAME%',
    '                set "FOUND=1"',
    '            ) else (',
    '                echo [DOWNLOAD] Installing to:',
    '                echo            %%d\\Scenario\\',
    '                curl -L --progress-bar -o "%%d\\Scenario\\%FILE_NAME%" "%FILE_URL%"',
    '                if !ERRORLEVEL! EQU 0 (',
    '                    echo [OK] Installed successfully.',
    '                    set "FOUND=1"',
    '                ) else (',
    '                    echo [FAIL] Download failed. Check your internet connection.',
    '                )',
    '            )',
    '            echo.',
    '        )',
    '    )',
    ')',
    '',
    'if "!FOUND!"=="0" (',
    '    echo [INFO] No valid Steam ID Scenario folder found under:',
    '    echo        %BASE%',
    '    echo Please check your game installation.',
    ')',
    '',
    ':end',
    'echo.',
    'echo Press any key to close...',
    'pause > nul',
  ];
  return lines.join('\r\n');
}

function handleInstallRequest(req, res) {
  const { campaignId, actId, levelId } = req.params;
  if (!/^\d+$/.test(campaignId) || !/^\d+$/.test(actId) || !/^\d+$/.test(levelId)) {
    return res.status(400).json({ error: "Invalid parameters" });
  }
  const levelName    = (req.query.name || 'Scenario').replace(/[<>:"/\\|*\x00-\x1f]/g, '').trim().slice(0, 60);
  const scenarioFile = `${levelName} COOP.age3Yscn`;
  // Client passes the exact download URL it already knows; fall back to server env var
  const downloadUrl  = req.query.dlurl
    ? decodeURIComponent(req.query.dlurl)
    : `${process.env.SERVER_URL || 'https://discordbackend-v2.onrender.com'}/api/coop/download/${campaignId}/${actId}/${levelId}`;
  const bat = buildBatInstaller(scenarioFile, downloadUrl);
  res.setHeader("Content-Disposition", `attachment; filename="Install ${levelName}.bat"`);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(bat);
}
app.get("/api/coop/install/:campaignId/:actId/:levelId", handleInstallRequest);
app.get("/coop/install/:campaignId/:actId/:levelId",     handleInstallRequest);
