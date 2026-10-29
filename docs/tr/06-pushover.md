# İsteğe bağlı: ntfy yerine Pushover

[English](../en/06-pushover.md) · [README](../../README.tr.md)

Bu sayfa isteğe bağlı. Program bildirimleri varsayılan olarak ntfy ile yollar. Tek bir ayar, servisi Pushover olarak değiştirir.

**Durum.** Programdaki kısım hazır ve testleri var. Telefondaki adımlar (hesap, uygulama ve anahtarlar) **henüz bir telefonda denenmedi**. Bu adımların her birinde bu not var. Bu sayfadaki Pushover servisiyle ilgili bilgiler pushover.net'ten geliyor. Yazar bu bilgileri doğrulamadı.

## Pushover ne zaman işe yarar?

[Pushover](https://pushover.net), kendi telefon uygulaması olan ücretli bir bildirim servisi.

- ntfy teslim onayı vermez. Yazarın kurulumunda bazı bildirimler telefonda görünmedi. Bkz. [Kaybolan bildirimler](03-ntfy.md#kaybolan-bildirimler).
- iPhone'da ntfy.sh push'u Google Firebase ve Apple üzerinden yollar. Kaynak: ntfy yapılandırma rehberi. Pushover'ın kendi uygulaması var. Bu yüzden Pushover push'u muhtemelen doğrudan Apple üzerinden yollar. Yazar bunu doğrulamadı.
- ntfy senin için iyi çalışıyorsa ntfy'yi kullanmaya devam et. Bu sayfaya ihtiyacın yok.

pushover.net'e göre yalnız acil öncelik bir alındı onayı verir. Program bu önceliği kullanmaz. Program, ntfy'de olduğu gibi, Pushover mesajı kabul edince bildirimi gönderilmiş sayar.

## Ücret

- pushover.net'e göre Pushover'ın 30 günlük ücretsiz bir deneme süresi var.
- pushover.net'e göre uygulama sonra her platform (örneğin iPhone) için bir kez 4,99 USD tutar.
- Yazar deneme süresini ve fiyatı doğrulamadı. Satın almadan önce ikisini de pushover.net'te kontrol et.
- Lisansı kullanıcı kendisi satın alır. Bir yapay zeka aracı bu adımı yapmamalı.

## Servis seçimi

| Ayar | Varsayılan | Anlamı |
|---|---|---|
| `notify_service` | `ntfy` | Tüm bildirimleri yollayan servis: `ntfy` veya `pushover`. Program aynı anda tek bir servis kullanır. |
| `pushover_token` | boş | Pushover uygulamanın API token'ı. 30 harf ve rakam. Gizli tut. |
| `pushover_user` | boş | Pushover kullanıcı anahtarın (user key) ya da bir teslim grubu anahtarı (delivery group key). 30 harf ve rakam. Gizli tut. |

`ntfy` seçiliyken program `pushover_token` ve `pushover_user` ayarlarını kullanmaz. `pushover` seçiliyken iki anahtar da gerekir ve program `ntfy_topic` ayarını kullanmaz.

**Pushover kullansan da `ntfy_topic` ayarını `config.json` içinde tut.** `ntfy-test` bu ayarı ister. Pushover'dan önceki bir sürüme dönüş (`sudo bash deploy/install.sh --rollback`) de bu ayarı ister. O eski sürüm `notify_service` ayarını tanımaz. Bildirimleri ntfy ile yollar ve `ntfy_topic` olmadan başlamaz. Pushover seçiliyken `ntfy_topic` boş ya da geçersizse `sudo mini-watch doctor` bir `WARN` satırı gösterir.

## 1. Hesabı ve anahtarları oluştur

**Henüz bir telefonda denenmedi.** Sitedeki ve uygulamadaki adlar farklı olabilir.

1. [pushover.net](https://pushover.net) sitesini aç ve bir hesap oluştur. Bu adımı yalnız kullanıcı yapar.
2. Telefona **Pushover** uygulamasını kur. Aynı hesapla giriş yap. Deneme süresi muhtemelen uygulamaya giriş yapınca başlar.
3. Uygulama izin isteyince bildirimlere izin ver.
4. pushover.net'te **Your User Key** alanını bul. Anahtarı kopyala. Bu, `pushover_user` ayarının değeri.
5. pushover.net'te bir uygulama oluştur (**Create an Application/API Token**). Ona bir ad ver, örneğin `MINI`. **API Token** değerini kopyala. Bu, `pushover_token` ayarının değeri.

İki anahtarı da parola gibi sakla. Onları sohbete, commit'e veya ekran görüntüsüne koyma.

## 2. Anahtarları config.json dosyasına yaz

```bash
sudo nano /var/lib/mini-watch/config.json
```

Dosyanın ilk satırında yalnız `{` var. Yeni satırları bu satırın hemen altına, dosyanın başına ekle. Eklediğin her satır virgülle biter. Diğer satırları değiştirme.

Dosyada `notify_service` satırı yoksa şu üç satırı ekle. Kendi anahtarlarını kullan. `{` satırı dosyada zaten var. Onu tekrar ekleme:

```json
{
  "notify_service": "ntfy",
  "pushover_token": "YOUR-PUSHOVER-API-TOKEN",
  "pushover_user": "YOUR-PUSHOVER-USER-KEY",
```

Dosyada `notify_service` satırı zaten varsa ikinci bir tane ekleme. Yalnız `pushover_token` ve `pushover_user` satırlarını ekle. `notify_service` şimdilik `ntfy` kalsın.

Kaydetmek için `Ctrl+O`, `Enter`, `Ctrl+X` tuşlarına bas.

Servis `config.json` dosyasını yalnız başlarken okur. Dosyadaki bir hata, servisi bir sonraki başlangıçta durdurur. Sunucu yeniden başlayınca da durdurur. Bu yüzden dosyayı şimdi kontrol et. Çıktıda `FAIL` satırı olmamalı:

```bash
sudo mini-watch doctor --offline
```

Çıktı `config.json` dosyasının geçerli bir JSON olmadığını söylerse tırnakları ve virgülleri kontrol et. `notify_service` değeri `ntfy` olduğu sürece servis anahtarları kullanmaz. Bu yüzden servisi şimdi yeniden başlatman gerekmez.

## 3. Deneme bildirimi yolla

**Henüz bir telefonda denenmedi.**

```bash
sudo mini-watch pushover-test
```

Komut, Pushover ile gerçek bir bildirim yollar. `notify_service` değeri `ntfy` iken de çalışır. Böylece Pushover'ı geçiş yapmadan önce deneyebilirsin.

- İyi sonuç: Çıktıda istek kimliğiyle (request id) birlikte `Notification accepted by Pushover` satırı görünür. Son satır `Result: Pushover accepted the test notification. Check the phone.` olur. Program "🚗 MINI deneme bildirimi" başlığını ve "Bildirim çalışıyor" metnini yollar. `language` değeri `en` ise "🚗 MINI test" ve "Notifications work" yollar. Telefonun bunları nasıl gösterdiği henüz denenmedi.
- Kötü sonuç: Son satır `Result: Pushover did not accept the test notification. See the line above.` olur. Sebep bir üstteki satırda yazar. Bkz. [Sorun giderme](#sorun-giderme).
- `config.json` içinde eksik ya da hatalı bir anahtar varsa komut bildirim yollamadan durur. Hata mesajı ayarın adını söyler. Değeri göstermez.

## 4. Pushover'a geç

**Henüz bir telefonda denenmedi.**

1. `config.json` dosyasını aç (2. bölüm). `"notify_service"` satırında `"ntfy"` değerini `"pushover"` yap. Satırın diğer karakterlerini değiştirme.
2. Yeniden başlatmadan önce dosyayı kontrol et. Çıktıda `FAIL` satırı olmamalı:

```bash
sudo mini-watch doctor --offline
```

3. Servisi yeniden başlat:

```bash
sudo systemctl restart mini-watch
```

4. Log'a bak. Yeniden başlatmadan sonra `Notification service: Pushover.` satırı görünür.

```bash
sudo journalctl -u mini-watch -n 20 --no-pager
```

5. Kurulumu kontrol et. Çıktıda `FAIL` satırı olmamalı. Kontrol, anahtarların geçerli olup olmadığını Pushover'a sorar. Bildirim yollamaz. Pushover seçiliyken ntfy sunucusundaki bir sorun `FAIL` olarak değil, `WARN` olarak görünür. Boş bir `ntfy_topic` de `WARN` olarak görünür.

```bash
sudo mini-watch doctor
```

Program başlamazsa log hatalı ayarı gösterir. Ayarı düzelt ve servisi yeniden başlat.

## 5. ntfy'ye geri dön

1. `config.json` dosyasını aç. `"notify_service"` satırında `"pushover"` değerini `"ntfy"` yap. Satırın diğer karakterlerini değiştirme.
2. Yeniden başlatmadan önce dosyayı kontrol et: `sudo mini-watch doctor --offline`. Çıktıda `FAIL` satırı olmamalı.
3. Servisi yeniden başlat: `sudo systemctl restart mini-watch`.

ntfy servisi `ntfy_topic` ayarını ister. Bu ayarı sildiysen yeniden başlatmadan önce tekrar yaz. Bu ayar olmadan program başlamaz. Pushover anahtarları `config.json` içinde kalabilir. `ntfy` seçiliyken program onları kullanmaz.

## Neler aynı kalır?

- Varsayılan servis `ntfy`. `notify_service` içermeyen bir `config.json` eskisi gibi çalışır.
- ntfy kısmı değişmez. `ntfy-test`, `ntfy-check` ve `ntfy_*` ayarları eskisi gibi çalışır. Bunlar her zaman ntfy kullanır.
- Metinler, bekleme süreleri, hatırlatmalar ve yeniden denemeler iki serviste de aynı.
- Pushover'da da emoji `ntfy_tags` ayarından gelir. Program Pushover'a etiket yollamaz. Emojiyi başlığın başına koyar.
- Program şu etiket adlarını tanır: `warning` (⚠️), `rotating_light` (🚨), `white_check_mark` (✅), `lock` (🔒), `grey_question` (❔), `blue_car` (🚙), `car` (🚗). Başka bir etiket adı emoji vermez.
- "Açık parça var" ve "hala açık parça var" bildirimleri Pushover'da 1 (yüksek) önceliğini alır. Diğer bildirimler 0 (normal) önceliğini alır.
- Başlık en çok 250 karakter olur. Metin en çok 1024 karakter olur. Daha uzun bir metin "…" ile biter.
- `ntfy-check` yalnız ntfy için çalışır. Bir Pushover mesajının ntfy kimliği değil, istek kimliği (request id) var.
- `tools/replay.mjs` aracı `pushover` seçiliyken de bir şey yollamaz.

## Sorun giderme

| Log satırı | Anlamı |
|---|---|
| `Notification accepted by Pushover: ... (request <id>, HTTP 200)` | Pushover bildirimi kabul etti. Bu bir teslim onayı değil. |
| `Notification not confirmed by Pushover: ...` | Pushover HTTP 2xx ile yanıt verdi ama yanıtta istek kimliği yok. Program bildirimi gönderilmiş saymaz. ntfy'de olduğu gibi daha sonra yeniden dener. |
| `Notification failed: HTTP 400` veya `HTTP 401` | Pushover mesajı reddetti. Bir anahtar hatalı olabilir. `sudo mini-watch doctor` komutunu çalıştır. |
| `Notification failed: HTTP 429` | Pushover mesajı reddetti. Olası bir sebep, Pushover'ın bir sınırı. Program daha sonra yeniden dener. |
| `Notification failed: HTTP 307, a redirect. ...` | Pushover bir yönlendirmeyle (redirect) yanıt verdi. İstekte token var. Bu yüzden program yönlendirmeyi izlemez. Daha sonra yeniden dener. |
| `Notification failed: no answer from Pushover (...)` veya `Notification failed: no answer from Pushover in 15 seconds` | Sunucu Pushover'a ulaşamadı ya da Pushover zamanında yanıt vermedi. Parantez içindeki metin hata kodu. Program daha sonra yeniden dener. |
| `Set "pushover_token" ...` veya `"pushover_user" must have 30 letters and digits ...` | Program başlamadı. `config.json` içindeki bir anahtar eksik ya da hatalı. Metin değeri göstermez. |
| `"notify_service" must be "ntfy" or "pushover" ...` | Program başlamadı. `config.json` içindeki değeri düzelt. |

Yeniden denemeler ntfy ile aynı kurallara uyar. [4. adımdaki](05-isletim.md#log-satırları-ne-anlama-gelir) `Notification failed` satırına bak.

## Sınırlar

- **Henüz bir telefonda denenmedi.** Programdaki kısmın testleri yalnız sahte bir Pushover yanıtı kullanır.
- **Acil öncelik henüz yok.** Pushover'ın bir acil (emergency) önceliği (2) var. pushover.net'e göre bu öncelik, sen onaylayana kadar bildirimi tekrarlar ve bir alındı onayı (receipt) verir. Program bunu kullanmaz. Bu, ileride eklenebilecek bir adım.
- **Teslim grupları.** Program `pushover_user` alanında bir teslim grubu anahtarını kabul eder. pushover.net'e göre bir grup anahtarı, kullanıcı anahtarının yerine çalışır. Grupla ilgili hiçbir adım henüz bir telefonda denenmedi.
- **Eski sürüme dönüş.** Pushover'dan önceki bir sürüm bildirimleri ntfy ile yollar ve `ntfy_topic` ister. Bkz. [Servis seçimi](#servis-seçimi).
- **Hata yanıtından sonra yeniden deneme.** Pushover HTTP 4xx ile yanıt verirse program normal bekleme süreleriyle yeniden dener ([4. adıma](05-isletim.md#log-satırları-ne-anlama-gelir) bak). pushover.net'e göre bir hata yanıtından sonra yollamaya devam eden bir uygulama engellenebilir (doğrulanmadı). Geçiş yapmadan önce bunu pushover.net'te kontrol et. Log'da tekrar eden reddetmeler görürsen ntfy'ye geri dön.
- **Aynı anda tek servis.** Program ntfy'ye ve Pushover'a birlikte yollamaz.
- **Gizlilik.** Bildirimler Pushover sunucularından geçer. Metinde konum, plaka ya da VIN yok.

**Sıradaki adım:** [4. adıma, programı çalıştır ve güncelle](05-isletim.md) sayfasına geri dön.
