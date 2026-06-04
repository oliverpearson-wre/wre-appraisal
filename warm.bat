@echo off
echo Refreshing MBIE rent data...
cd /d "%~dp0"
node scripts/warm-mbie.js
git add data/mbie-waikato.json
git commit -m "Refresh MBIE data %date%"
git push
echo Done! Data is live.
pause
