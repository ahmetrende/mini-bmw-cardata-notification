# 2. adım / 5: Telefona ntfy uygulamasını kur

[English](../en/03-ntfy.md) · [README](../../README.tr.md)

**Süre: 5 dakika.**

[ntfy](https://ntfy.sh) ücretsiz ve açık kaynaklı bir bildirim servisi. Hesap veya telefon numarası istemiyor.

## 1. Bir konu adı seç

Konu adı parola gibi davranır. Adı bilen herkes bildirimlerini okuyabilir. Bu yüzden uzun ve rastgele bir ad seç.

Bilgisayarında rastgele bir ad üret:

```bash
echo "mini-$(openssl rand -hex 9)"
```

Örnek çıktı: `mini-3f9a1c7e2b5d8e0a4c`

Bu komut Windows PowerShell'de çalışmaz. Windows'ta adı kendin yaz: `mini-` ve ardından 18 rastgele harf ve rakam.

Adı kopyala ve sakla. 3. adımda lazım olacak.

## 2. Uygulamayı kur ve abone ol

1. **ntfy** uygulamasını kur. iPhone için App Store, Android için Google Play veya F-Droid.
2. Uygulamayı aç. Bildirim izni isterse izin ver.
3. **+** düğmesine bas.
4. Konu adını yaz.
5. Sunucu ayarına dokunma. Varsayılan `ntfy.sh` kalsın.
6. **Subscribe** düğmesine bas.

## 3. Dene

Bilgisayarından bir deneme bildirimi yolla. `TOPIC` yerine kendi konu adını yaz:

```bash
curl -d "Deneme bildirimi" https://ntfy.sh/TOPIC
```

Telefonuna bildirim düşmeli. Düşmezse telefon ayarlarında ntfy için bildirimlerin açık olduğunu kontrol et.

## Telefon notları

**iPhone.** Program iPhone ile test edildi. Uygulama izin isteyince bildirimlere izin ver.

**Android.** Android'de **denenmedi.** ntfy belgeleri şunları söylüyor:

- Uyku modundaki (doze) bir telefon mesajları geciktirebilir. Gecikme dakikalarca sürebilir.
- Gecikmeyi azaltmak için ntfy ayarlarında anında teslimi aç. Seçeneğin adı "Subscription Service".
- F-Droid sürümü, tüm aboneliklerde anında teslimi varsayılan olarak kullanır.

Menü adları uygulama sürümüne göre değişebilir. Android'de bildirim geç geliyorsa önce bu ayarlara bak.

## Güvenlik

- Bildirimler uçtan uca şifreli değil. ntfy.sh sunucusu metni okuyabilir.
- Metin yalnızca açık parçaları ve saatlerini söyler. Örnek: "Açık: sağ ön cam 13:50'den beri". Konum, plaka ve VIN yoktur.
- Daha fazla gizlilik istersen kendi ntfy sunucunu kur. Sonra `config.json` dosyasında `ntfy_server` alanını ayarla.

**Sıradaki adım:** [3. adım, sunucu kurulumu](04-sunucu-kurulumu.md) sayfasına geç.
