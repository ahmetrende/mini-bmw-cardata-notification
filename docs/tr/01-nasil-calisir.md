# Nasıl çalışır?

[English](../en/01-how-it-works.md) · [README](../../README.tr.md)

Bu sayfa isteğe bağlı. Programın ne yaptığını ve hangi veriye ihtiyaç duyduğunu öğrenmek istersen oku.

## Veri nereden nereye gider?

1. Araç, durum değişikliklerini BMW sunucusuna yollar. Örnekler: kapı açıldı, cam kapandı, kilometre arttı. Bağlantılı her araç bunu zaten yapar.
2. Portalda bir CarData akışı açarsın. BMW, senin verilerini bir MQTT akışına koyar.
3. Program bu akışa TLS ile bağlanır ve dinler.
4. Bir parça açık kalırsa program ntfy.sh'e bir mesaj yollar.
5. ntfy uygulaması bildirimi telefonuna düşürür.

Program araca bağlanmaz. Aracı da uyandırmaz.

## Programın izlediği parçalar

| Parça | CarData özniteliği | Açık sayılan değer |
|---|---|---|
| 4 kapı | `vehicle.cabin.door.row{1,2}.{driver,passenger}.isOpen` | `true` |
| 4 cam | `vehicle.cabin.window.row{1,2}.{driver,passenger}.status` | `OPEN`, `INTERMEDIATE` |
| Cam tavan (sürgü) | `vehicle.cabin.sunroof.status` | `OPEN`, `INTERMEDIATE` |
| Cam tavan (aralık) | `vehicle.cabin.sunroof.tiltStatus` | `OPEN`, `INTERMEDIATE` |
| Bagaj | `vehicle.body.trunk.isOpen`, `vehicle.body.trunk.door.isOpen` | `OPEN`, `INTERMEDIATE`, `true` |
| Kaput | `vehicle.body.hood.isOpen` | `true` |

Aracın bu öznitelikleri yollaması gerekir. Portal, aracının yolladığı özniteliklerin listesini gösterir. Listeyi nasıl okuyacağın 1. adımda yazıyor.

## Araç yolda mı, park halinde mi?

Test edilen araç kontak, hareket ve hız verisi yollamıyor. Program, aracın yolda olduğunu kilometre sayacından (`vehicle.vehicle.travelledDistance`) anlıyor.

| Durum | Programın kararı |
|---|---|
| Kilometre, sürücü kapısı son açıldıktan sonra ve son 30 dakika içinde arttı | Araç yolda. Bildirim yok. |
| Kilometre arttı, ardından sürücü kapısı açıldı | Sürücü indi. Park başladı. |
| Kilometre 30 dakikadır artmıyor | Araç park halinde. Trafik sıkışıklığında kilometre 10 dakikadan uzun durabilir. |
| Programda hiç kilometre verisi yok | Bir parça 10 dakikadır açıksa bildirim düşer. |

Aracın `isIgnitionOn` veya `isMoving` verisi varsa program onları da kullanır.

## Bildirim kuralları

| Kural | Varsayılan | `config.json` ayarı |
|---|---|---|
| Sürücü kapısı son açıldıktan sonraki bekleme | 10 dakika | `alert_after_min` |
| Parça hâlâ açıksa ilk hatırlatma | 60 dakika | `remind_every_min` |
| İki hatırlatma arasındaki en uzun süre | 480 dakika (8 saat) | `remind_max_min` |
| Kilometre bu kadar durursa araç park sayılır | 30 dakika | `park_after_idle_min` |
| Bildirim metninin dili | `en` | `language` (`en` veya `tr`) |
| Bildirimdeki saatlerin saat dilimi | sunucunun saat dilimi | `timezone` (örnek: `Europe/Istanbul`) |

- **Neden 10 dakika?** Sürücü kapısı biniş sırasında da açılır. Test aracında ilk kilometre verisi, binişten 3 ile 7 dakika sonra geldi. 10 dakikalık bekleme bu süreyi karşılar. Sayaç, sürücü kapısı her açıldığında baştan başlar.
- **Hatırlatmalar.** Her hatırlatma bir öncekinin iki katı bekler: 1 saat, 2 saat, 4 saat, sonra 8 saat. Gece boyunca açık kalan bir parça saat başı bildirim yollamaz.
- **Tek mesaj.** Bildirim, açık olan tüm parçaları sıralar. En eski açılan parça başta durur.
- **Her parçanın saati.** Bildirimde "13:48'den beri" gibi bir saat görürsün. Bu saat, programın o parçayı ilk kez açık gördüğü andır. Parça önceki bir günden beri açıksa tarih de yazar. Örnek: "6 Eki 13:48'den beri". Program yeniden başlarsa son 24 saatin mesajlarını yeniden okur ve o dönemin gerçek saatlerini korur. 24 saatten uzun süredir açık kalan bir parçanın saati, okumanın başladığı an olarak görünür.
- **Yeni bir parça açılırsa.** Bekleme süresi dolunca yeni bir bildirim düşer. Bu bildirim de tüm açık parçaları sıralar.
- **Hepsini kapatırsan.** Tek bir mesaj gelir ve her şeyin kapandığını söyler. Bu mesaj, daha önce bir bildirim gelmişse gelir. Program bu mesajı yalnızca bir parçanın kapandığını gördüğünde yollar. Veri gelmemesi "kapandı" anlamına gelmez.
- **Yeniden yola çıkarsan.** Program eski bildirimi unutur. Bir sonraki parkta yeni bir bildirim gelebilir.

## Bir şey ters giderse ne olur?

- **Token yenileme.** Akış parolası (ID token) 1 saat geçerli. Program parolayı süresi dolmadan 5 dakika önce yeniler. Yenileme anahtarı 2 hafta geçerli ve her yenilemede süresi uzar. Sunucu 2 haftadan uzun kapalı kalırsa yeniden giriş yapman gerekir.
- **Bağlantı kopması.** Sağlıklı bir bağlantı kapanırsa program 5 saniye sonra yeniden bağlanır. Bağlantı art arda kısa sürede koparsa bekleme süresi 60 saniyeye kadar ikiye katlanır. BMW, kısa sürede çok sayıda bağlantı denemesini sınırlar.
- **Yeniden başlama.** Program son 24 saatin mesajlarını yeniden okur. Kilometre ve kapı geçmişi kaybolmaz. Yolladığı bildirimleri `state.json` dosyasına yazar. Aynı bildirim ikinci kez gitmez.
- **Her mesajda tam durum.** Araç, seçtiğin tüm öznitelikleri her mesajda yollar. Kaybolan bir mesaj, bir durumu uzun süre gizlemez.

## İleride yeni olaylar

Program yalnızca kapıları, camları, cam tavanı, bagajı ve kaputu izliyor. CarData'da daha fazla öznitelik var. Yeni bir olay için kodda değişiklik gerekir. İstersen bir issue aç ve talebini yaz.

## Teknik ayrıntılar

| Öğe | Değer |
|---|---|
| Giriş | PKCE'li OAuth 2.0 Device Code Flow, `customer.bmwgroup.com/gcdm/oauth` |
| Kapsamlar | `authenticate_user openid cardata:streaming:read cardata:api:read` |
| Akış | MQTT 3.1.1, `customer.streaming-cardata.bmwgroup.com:9000`, TLS 1.3 şart |
| MQTT kullanıcı adı ve parolası | GCID ve ID token |
| Konu | `<GCID>/+` (hesaptaki tüm araçlar) |
| Keepalive | 30 saniye. Broker, 60 saniyelik keepalive'e sahip bağlantıyı kapatır. |
| QoS | 0. Broker yalnızca QoS 0 destekler. |

macOS'un sistem Python'u LibreSSL kullanır ve TLS 1.3 desteklemez. Program bu yüzden Node.js ile yazıldı.

**Sıradaki adım:** [1. adım, CarData portalı](02-cardata-portali.md) sayfasına geç.
