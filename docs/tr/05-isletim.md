# 4. adım / 5: Programı çalıştır ve güncelle

[English](../en/05-operations.md) · [README](../../README.tr.md)

Tüm komutları sunucuda çalıştır. Sunucuya bağlanmak için:

```bash
gcloud compute ssh cardata-server --zone=us-central1-a --tunnel-through-iap
```

## Sık kullanılan komutlar

| Ne yapmak istiyorsun? | Komut |
|---|---|
| Durumu görmek | `systemctl status mini-watch --no-pager` |
| Log'u canlı izlemek | `sudo journalctl -u mini-watch -f` |
| Mesaj satırları olmadan log görmek | `sudo journalctl -u mini-watch -n 500 --no-pager \| grep -v "Message:" \| tail -30` |
| Yollanan bildirimleri görmek | `sudo journalctl -u mini-watch --no-pager \| grep -E "Notification (sent\|accepted)" \| tail -20` |
| Yeniden başlatmak | `sudo systemctl restart mini-watch` |
| Durdurmak | `sudo systemctl stop mini-watch` |
| Deneme bildirimi yollamak | `sudo mini-watch ntfy-test` |
| ntfy'de bir bildirimin hala durup durmadığını görmek (bir şey yollamaz) | `sudo mini-watch ntfy-check <id>`. Mesaj kimliği `Notification accepted by ntfy` log satırında yazar. |
| Pushover ile deneme bildirimi yollamak (gerçek bir bildirim yollar, `notify_service` değeri `ntfy` iken de) | `sudo mini-watch pushover-test`. Bkz. [Pushover](06-pushover.md). |
| Kurulumu kontrol etmek (bir şey yollamaz) | `sudo mini-watch doctor` |

Log'u bilgisayarından tek komutla izlemek için:

```bash
gcloud compute ssh cardata-server --zone=us-central1-a --tunnel-through-iap --command='sudo journalctl -u mini-watch -f'
```

## Log satırları ne anlama gelir?

Log satırları her zaman İngilizce yazılır. Yalnızca bildirim metni `language` ayarına göre değişir.

| Satır | Anlamı |
|---|---|
| `Connected to the stream.` ve `Subscribed: qos0` | Bağlantı sağlıklı. |
| `Message: vehicle....` | Araçtan veri geldi. |
| `Notification accepted by ntfy: ...` | ntfy bildirimi kabul etti. Satırda başlık, metin, mesaj kimliği, HTTP durum kodu, mesajın zamanı ve silineceği zaman (UTC) var. Zaman ve silineceği zaman yalnız ntfy geçerli değerler yollarsa görünür. "Kabul etti", ntfy'nin mesajı kaydettiği anlamına gelir. Telefonun bildirimi aldığı anlamına gelmez. ntfy teslim onayı vermez. Eski log satırları `Notification sent: ...` der. Bu satırlarda HTTP durum kodu, zaman ve silineceği zaman yoktur. Yollanan tüm bildirimleri listelemek için: `sudo journalctl -u mini-watch --no-pager \| grep -E "Notification (sent\|accepted)"`. |
| `Notification not confirmed: ...` | ntfy HTTP 2xx ile yanıt verdi ama yanıtta mesaj kimliği yok. Program bildirimi gönderilmiş saymaz. `Notification failed` satırında olduğu gibi daha sonra yeniden dener. Satır tekrar ediyorsa `config.json` içindeki `ntfy_server` değerini kontrol et. |
| `Notification service: Pushover.` | Program `notify_service` değeri `pushover` iken başladı. ntfy ile bu satır görünmez. Bkz. [Pushover](06-pushover.md). |
| `Notification accepted by Pushover: ...` | Pushover bir bildirimi kabul etti. Satırda başlık, metin, istek kimliği (request id) ve HTTP durum kodu var. Bu bir teslim onayı değil. |
| `Notification not confirmed by Pushover: ...` | Pushover HTTP 2xx ile yanıt verdi ama yanıtta istek kimliği yok. Program bildirimi gönderilmiş saymaz. `Notification failed` satırında olduğu gibi daha sonra yeniden dener. |
| `The token expires soon. Refreshing it.` | Normal yenileme. Her saat olur. |
| `Reconnecting in 5 seconds.` | Bağlantı kapandı, program yeniden bağlanıyor. Token yenilemesinden sonra bu satırı her saat görürsün. |
| `MQTT error: Keepalive timeout` | Ağ kesintisi. Arada bir olması normal. Sık oluyorsa ağı kontrol et. |
| `Could not refresh the token ...` | Yeniden giriş yapman gerekiyor. Aşağıya bak. |
| `Notification failed: ...` | ntfy'ye ulaşılamadı ya da ntfy bir HTTP hatasıyla yanıt verdi. İlk yeniden deneme yaklaşık 30 saniye sonra gelir. Temel bekleme her hatada iki katına çıkar ve 10 dakikada durur. Program buna yüzde 20'ye kadar rastgele bir sapma ekler. Bu yüzden en uzun bekleme yaklaşık 12 dakikadır. Program her denemeden önce bildirimin hala gerekip gerekmediğini yeniden kontrol eder. Araçtan veri gelmediğini söyleyen bildirim sabit 10 dakika bekler. ntfy ile satır tekrar ediyorsa konu adını ve ağı kontrol et. Pushover'da da aynı yeniden deneme kuralları geçerli. Bir ağ hatası o zaman `Notification failed: no answer from Pushover (...)` veya `Notification failed: no answer from Pushover in 15 seconds` olarak görünür. Pushover ile satır tekrar ediyorsa anahtarları ve bağlantıyı `sudo mini-watch doctor` komutuyla kontrol et. |
| `Subscribe error: ... Reconnecting.` | Akış aboneliği reddetti. Program yeniden bağlanır. Satır tekrar ediyorsa portalda **CarData Stream** anahtarının açık olduğunu kontrol et. |
| `The history file is full. ...` | `messages.jsonl` 10 MB'a ulaştı ve `messages.jsonl.1` oldu. Bu normal. |
| `A stream message was skipped: ...` | Mesaj çok büyüktü (64 KB'tan fazla). Program onu kaydetmedi. |
| `Unknown value "..." for ...` | Araç, programın tanımadığı bir değer yolladı. Parça son bilinen durumunda kalır. Lütfen bir issue aç ve bu satırı ekle. |
| `Set "ntfy_topic" ...`, `Set "pushover_token" ...` veya `"..." must be a number of minutes ...` | Program başlamadı. `config.json` içindeki bir değer hatalı. Düzelt ve servisi yeniden başlat. |

## Ayarları değiştir

```bash
sudo nano /var/lib/mini-watch/config.json
sudo systemctl restart mini-watch
```

| Alan | Varsayılan | Anlamı |
|---|---|---|
| `language` | `en` | Bildirim metninin dili: `en` veya `tr` |
| `timezone` | sunucunun saat dilimi | Bildirimdeki saatlerin saat dilimi. Örnek: `Europe/Istanbul` |
| `alert_after_min` | 10 | Sürücü kapısı son açıldıktan sonra bildirimden önceki bekleme |
| `alert_after_lock_min` | 0 | Aracı dışarıdan kilitledikten sonra, kilitlerken açık olan parça için bekleme. 0 = hemen. Camları kilit düğmesiyle kapatıyorsan 1 yap. |
| `remind_after_min` | `[30, 90]` | Hatırlatmalar, ilk bildirimden kaç dakika sonra. `[]` = hatırlatma yok. En çok 10 değer, her biri öncekinden büyük. |
| `park_after_idle_min` | 30 | Kilometre bu kadar durursa araç park sayılır |
| `ntfy_tags` | aşağıya bak | Başlığın başındaki emoji. Her bildirim türü için bir ntfy etiket adı: `open`, `still_open`, `closed`, `locked`, `silence`, `test`. Varsayılanlar: `warning` (⚠️), `warning`, `white_check_mark` (✅), `lock` (🔒), `grey_question` (❔), `car` (🚗). Örnek: `{"open": "rotating_light"}`. Yazmadığın tür varsayılanını korur. Adlar [ntfy emoji listesinde](https://docs.ntfy.sh/emojis/). |
| `notify_trip` | `false` | `true` = ilk bildirimlerin sonunda (hatırlatmalarda değil) son sürüşün süresi, parantez içinde. Örnek: `(sürüş 23 dk)`. Yalnız son ayrıntılı bildirimden sonra kilometre arttıysa (sürüşten sonra) görünür. |
| `notify_battery` | `false` | `true` = ilk bildirimlerin sonunda (hatırlatmalarda değil) batarya seviyesi ve menzil, parantez içinde. Örnek: `(batarya %64, menzil 187 km)`. Attribute'lar akışta olmalı. `notify_trip` ile aynı kural: yalnız sürüşten sonra. Şarj durumu bunun dışında: her zaman görünür. |
| `notify_battery_below_pct` | 100 | 1 ile 100 arasında bir sayı. Batarya seviyesi ve menzil, seviye bu yüzdenin altındaysa görünür. Örnek: `30` yazarsan yalnız %30'un altında görünür. 100 = her zaman. Yalnız `notify_battery` açıksa çalışır. Araç şarj olurken bu sınır uygulanmaz. |
| `lock_confirm` | `false` | `true` = aracı kilitleyince ve her parça kapalıyken "kilitlendi, her şey kapalı" mesajı. Sistemin çalıştığını gösterir. |
| `silence_alert_hours` | 0 (kapalı) | Araçtan bu kadar saat veri gelmezse tek bir bildirim. Araç uyurken hiçbir şey yollamaz. Bu yüzden uzun süre park halinde de bu bildirim gelir. |
| `vehicle_names` | `{}` | Hesapta birden fazla araç varsa araçların adları. Örnek: `{"VIN-OF-CAR-1": "Countryman"}` |
| `ntfy_server` | `https://ntfy.sh` | Kendi ntfy sunucunun adresi |
| `notify_service` | `ntfy` | Tüm bildirimleri yollayan servis: `ntfy` veya `pushover`. Bkz. [Pushover](06-pushover.md). |
| `pushover_token` | boş | Pushover uygulamanın API token'ı (30 harf ve rakam). Gizli. Yalnız `pushover` seçiliyken ve `pushover-test` komutunda kullanılır. |
| `pushover_user` | boş | Pushover kullanıcı anahtarın ya da bir teslim grubu anahtarı (30 harf ve rakam). Gizli. Yalnız `pushover` seçiliyken ve `pushover-test` komutunda kullanılır. |

## Programı güncelle

1. Sunucuya bağlan.
2. Şunu çalıştır:

```bash
cd ~/mini-bmw-cardata-notification
git pull
sudo bash deploy/install.sh
```

Betik şu adımları izler:

1. Yeni sürümü `/opt/mini-watch/releases` içinde yeni bir klasöre kurar. Çalışan servis onu henüz kullanmaz.
2. Yeni sürümü senin ayarlarınla kontrol eder (`doctor --offline`). Bir kontrol başarısız olursa hiçbir şey değişmez.
3. Yeni sürüme geçer ve servisi yeniden başlatır.
4. `Subscribed` satırını en çok 2 dakika bekler. Satır gelmezse önceki sürüme döner.

Betik `config.json` ve `tokens.json` dosyalarına dokunmaz. En yeni 3 sürümü saklar. Eski kurulumlar kodu ve verileri `/opt/mini-watch` içinde tutuyordu. Betik bunları bir kez taşır. Eski `run.log` dosyası `/var/lib/mini-watch/run-before-journal.log` olur.

Önceki sürüme elle dönmek için:

```bash
sudo bash deploy/install.sh --rollback
```

## Yeniden giriş yap

Şu durumlarda yeniden giriş yapman gerekir:

- Sunucu 2 haftadan uzun süre kapalı kaldı. Yenileme anahtarının süresi doldu.
- Portalda Client ID'yi sildin veya bir aboneliği kapattın.
- Log'da `Could not refresh the token` satırı çıkıyor.

```bash
sudo systemctl stop mini-watch
sudo mini-watch login
sudo systemctl start mini-watch
```

Giriş adımları için [3. adımın](04-sunucu-kurulumu.md) 7. bölümüne bak.

## Sorun giderme

| Sorun | Olası sebep | Çözüm |
|---|---|---|
| Log'da hiç `Message:` satırı yok | Araç uykuda. | Uzaktan ışık sinyali yolla veya bir kapıyı açıp kapat. |
| `Message:` satırı yok, ama aracı kullanıyorsun | Akış kurulu değil. | Portalda **Configuration status** değerinin **ready** olduğunu kontrol et. |
| `Connection refused` | Token kapsamı eksik. | İki aboneliği kontrol et. Yeniden giriş yap. |
| Çok sayıda `Reconnecting` satırı | Program aynı hesapla başka bir yerde de çalışıyor. | Diğer kopyayı durdur. Hesap tek bağlantıya izin veriyor. |
| Yoldayken bildirim geliyor | Akışta `travelledDistance` yok. | Portalda bu attribute'u ekle. |
| Aralık cam tavan için bildirim gelmiyor | Akışta `tiltStatus` yok. | Portalda bu attribute'u ekle. |
| Bildirimdeki saat yanlış | `timezone` ayarı boş veya yanlış. | `config.json` içine kendi saat dilimini yaz. Örnek: `Europe/Istanbul`. |
| Log "Notification accepted by ntfy" diyor ama telefonda bir şey yok | Abonelik yok, bildirimler kapalı ya da push telefona ulaşmadı. | ntfy uygulamasında konu adını ve telefon izinlerini kontrol et. Sonra [Kaybolan bildirimler](03-ntfy.md#kaybolan-bildirimler) bölümündeki adımları izle. |
| SSH "Connection timed out" veriyor | `--tunnel-through-iap` bayrağı eksik. | Bayrağı ekle. Sunucu yalnızca IAP tünelini kabul ediyor. |
| Bayrak var ama SSH yanıt vermiyor | Sunucunun belleği dolu. | 5 dakika bekle. Sonra sunucuyu durdurup başlat: `gcloud compute instances stop` ve `start`. `reset` kullanma. `tools/replay.mjs` aracını sunucuda çalıştırma. |

## Sunucuyu yeniden başlat

Normal kapanışı kullan:

```bash
sudo systemctl reboot
```

Konsoldaki **Reset** düğmesini veya `gcloud compute instances reset` komutunu kullanma. Ani sıfırlama, hemen önce yazdığın dosyaları bozabilir.

## Disk kullanımı

Sistem günlüğü son 7 günün log'unu tutur. Bir iş, eski log dosyalarını her gece sunucunun saat diliminde 05:00'te siler. İş dosyaları bütün olarak siler. Bu yüzden log 8 güne kadar geriye gidebilir. Program mesaj geçmişini 10 MB'lık iki dosyayla sınırlar. Bir şey temizlemen gerekmez. Boş alanı görmek için `sudo mini-watch doctor` komutunu çalıştır.

İşin bir sonraki çalışma zamanını görmek için bu komutu çalıştır:

```bash
sudo systemctl list-timers mini-watch-log-clean.timer
```

7 günü değiştirmek için `deploy/mini-watch-log-clean.service` dosyasındaki `7d` ve `+7` değerlerini değiştir. Sonra `sudo bash deploy/install.sh` komutunu yeniden çalıştır.

## Her şeyi sil

1. Portalda **Delete stream** ve **Delete Client** düğmelerine bas.
2. Google Cloud projesini sil:
   ```bash
   gcloud projects delete PROJECT_NAME
   ```
3. Telefondaki ntfy aboneliğini sil.
4. Pushover kullanıyorsan pushover.net'teki uygulamayı sil.

**Sıradaki adım:** [Nasıl çalışır](01-nasil-calisir.md) sayfasını oku. Bu sayfa isteğe bağlı.
