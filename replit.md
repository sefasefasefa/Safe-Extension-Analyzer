# Safe Extension Analyzer

Bu proje, Instagram üzerinde çalışan Manifest V3 tarayıcı uzantısının içe aktarılmış ve güvenli davranışlarla düzenlenmiş sürümüdür.

## Kullanım

- Uzantı dosyaları: `safe-extension/panel_fixed/`
- Chrome veya Edge: geliştirici modunu açıp `safe-extension/panel_fixed/` klasörünü paketsiz uzantı olarak yükleyin.
- Firefox: `safe-extension/panel_fixed/manifest.json` dosyasını geçici eklenti olarak yükleyin.

## Güvenlik kararları

- Instagram oturum çerezi değiştiğinde panel otomatik açılmaz.
- Uzantı artık arka planda Instagram sekmesi oluşturmaz.
- Çıkış/temizleme işlemi Instagram çerezlerini silmez ve açık sekmeleri yönlendirmez; yalnızca uzantının yerel verilerini temizler.
- Paneldeki genel tıklama dinleyicisi kaldırıldı; sıradan sayfa tıklamaları logout başlatamaz.
- Oturum yoksa otomasyon duraklatılır, ancak kullanıcı login/logout sayfasına zorla gönderilmez.
- Instagram sekmesi ve liste sayfası navigasyonu yalnızca kullanıcı panelde ilgili işlemi başlattığında kullanılır.

## Doğrulama

- Tüm JavaScript dosyaları `node --check` ile kontrol edildi.
- `manifest.json` geçerli JSON olarak doğrulandı.

## Proje haritası

- `safe-extension/panel_fixed/manifest.json` — uzantı izinleri ve giriş noktaları
- `safe-extension/panel_fixed/background.js` — servis worker, otomasyon ve güvenli oturum durdurma
- `safe-extension/panel_fixed/content-script.js` — açık Instagram sekmesindeki kontrollü istekler
- `safe-extension/panel_fixed/page-data-bridge.js` — sayfa yanıtlarını gözlemleyen köprü
- `safe-extension/panel_fixed/logout-handler.js` — yalnızca uzantı yerel verilerini temizleyen panel düğmesi
- `safe-extension/panel_fixed/popup-logout.js` — popup içindeki aynı temizleme işlemi

## User preferences

- Mevcut tarayıcı uzantısı yapısını koru.
- Instagram oturum, çerez ve rate-limit işlemlerinde fail-closed davran.
- Kullanıcı açıkça istemedikçe sekme açma, yönlendirme veya üçüncü taraf çerezlerini değiştirme.
