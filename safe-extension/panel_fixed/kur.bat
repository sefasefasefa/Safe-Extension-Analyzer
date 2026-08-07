@echo off
chcp 65001 >nul
title Takipci Paneli - Kurulum Yardimcisi
color 0A

echo.
echo  ======================================================
echo    Takipci Paneli v19 - Kurulum Yardimcisi
echo  ======================================================
echo.
echo  Bu klasor yolu kopyalanacak:
echo  %~dp0
echo.

:: Klasör yolunu panoya kopyala
echo %~dp0| clip

echo  [OK] Klasor yolu panoya kopyalandi!
echo.
echo  SIMDI YAPILACAKLAR:
echo  -------------------------------------------------------
echo  CHROME / EDGE icin:
echo    1. Tarayicida   chrome://extensions   adresini acin
echo       (Edge icin:  edge://extensions  )
echo    2. Sag ustte "Gelistirici modu" ni acin
echo    3. "Paketsiz yukle" dugmesine basin
echo    4. Acilan pencerede adres cubuguna Ctrl+V yapin
echo       (yol zaten panoda)
echo    5. Klasoru secin - Tamam'a basin
echo.
echo  FIREFOX icin:
echo    1. Tarayicida   about:debugging   adresini acin
echo    2. "Bu Firefox" > "Gecici Eklenti Yukle"
echo    3. Bu klasorden  manifest.json  dosyasini secin
echo.
echo  -------------------------------------------------------

:: Klasörü Explorer'da aç (görsel referans için)
explorer "%~dp0"

:: Chrome/Edge açmayı dene
start "" "chrome://extensions" 2>nul
timeout /t 2 >nul
start "" "microsoft-edge:extensions" 2>nul

echo.
echo  Kurulum tamamlandiktan sonra bu pencereyi kapatabilirsiniz.
pause >nul
