@echo off
rem Starts the free-profile media engine (Cloudflare quick tunnel + engine) and keeps it running. Close the window or press Ctrl+C to stop.
cd /d "%~dp0"
title Telegram video downloader - media engine
node scripts\run-engine.mjs
echo.
echo The engine stopped.
pause
