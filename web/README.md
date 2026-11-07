# よりみち：画面担当用

2026-11-07版のチーム仕様に合わせた、ビルド不要のHTML/CSS/JavaScriptです。
`api/`、Pythonコード、クラウド設定は変更しません。ブランチは `momoka` を使います。

## 最初に見本で動かす

ZIPを展開した中の `web` フォルダを `~/DevFest/semantic_walk_PoC/` の直下に置きます。
すでに `web` に編集がある場合は、上書き前に内容を比較してください。

ターミナル（VS Codeなら上部メニュー「ターミナル」→「新しいターミナル」）で実行します。

```bash
cd ~/DevFest/semantic_walk_PoC
python3 -m http.server 8503 --bind 127.0.0.1 --directory web
```

Chromeで `http://localhost:8503/?mock=1` を開きます。
終了はサーバーを動かしたターミナルで Control+C。
HTMLのダブルクリックによる `file://` では動かさないでください。

見本モードはGoogle/Gemini/自分たちのAPIを呼ばず、キーも不要です。
地図の代わりに「模式図」を表示します。座標・ルート・OSM番号は操作確認用で、現地調査したデータではありません。
polylineも点を直接結んだ見本で、Routes APIの実結果ではありません。
選択した気分や出発地によって、見本の場所自体は変わりません。「外す」は見本内で対象IDを取り除きます。

## 操作できる範囲

- 初回の注意 → 気分入力 → 選択肢／自由記述／おまかせ → 時間・出発地 → ルート
- OSMの `id` で除外し、再検索（除外記録はlocalStorage）
- 歩行 → 自動／手動到着 → 静かな画面 → 5段階評価 → 次の場所／完了
- API待ち時間の経過秒数、キャンセル、65秒のタイムアウト、429などのエラー表示
- `blocked.message` があれば他の操作・結果は表示せず、文章のみ表示
- nullableな `place_id` / `maps_uri`、帰属表示、参照元リンク

気分確認は、現行のAPI仕様に合わせ1往復です。2回質問する場合は、回答履歴を渡すAPI仕様を相方と合意してから変更してください。

## 現在地・到着判定

見本では勝手に現在地を要求しません。歩行画面の「この場所への到着を再現」で試せます。
「現在地で到着判定を試す」は本物のブラウザ位置情報を使います。

Chromeの開発者ツール → メニュー → More tools → Sensors → Locationで、次の場所の座標を指定すると、GPS到着も確認できます。
例：見本の最初の場所は緯度 `34.9921`、経度 `135.7869`。
距離50m以内・精度50m以内・30秒以内の位置情報で到着とします。
精度不足、拒否、取得失敗のときも「着いた」で進めます。
到着・終了・ページ離脱時はwatchPositionを解除します。画面を閉じた後やスマホのバックグラウンド動作は保証しません。

位置情報はlocalhostまたはHTTPSで試してください。
スマホからPCのHTTPのLANアドレスへアクセスした場合は、位置情報を使えないことがあります。
実機確認は相方のHTTPSの公開URLで行います。
距離は直線距離で、方角は北基準です。歩く道の指示や端末の向きを示すコンパスではありません。

## Googleマップと実APIに接続する

相方がFastAPIから `web/index.html` をトップページとして配信し、CSS・JS・見本・config.jsも配信する必要があります。
通常モードは `/api/clarify` と `/api/route` を同一オリジンで呼びます。
上記のPython静的サーバーだけでは実APIは動きません。

1. `web/config.example.js` を `web/config.js` にコピーする。
2. `window.MAPS_JS_API_KEY` にブラウザ用のMaps JavaScript APIキーを設定する。
3. 相方にAPI制限（Maps JavaScript API）とウェブサイト制限（localhostと公開URL）を設定してもらう。
4. 相方のFastAPIを起動したURLを `?mock=1` なしで開く。

`config.js` は `web/.gitignore` で除外済み。サーバー用のPlaces/Routes/Geminiキーは書かないでください。
Cloud RunにはGitに入っていないconfig.jsは自動では届きません。
相方に、デプロイ時の生成や設定配信などの方法を用意してもらいます。API仕様は勝手に変更していません。

通常モードはgeometryライブラリでencodedPolylineを復号し、Googleマップに線とピンを表示します。
歩行中もGoogleマップを表示し、現在地マーカーを更新します。
Googleマップが読み込めない場合、場所一覧を隠してエラーにします。
到着・評価画面ではGoogle由来の場所情報を表示しません。

## 保存とプライバシー

ブラウザのlocalStorageに保存するのは、注意への同意、除外したOSM ID（直近200件）、評価（直近100件）のみです。
現在地、出発地、Mapsのレスポンス全体はlocalStorageに保存しません。
評価や歩行中の座標を自分たちのサーバーへ送る処理もありません。
Googleマップ表示時はGoogleのSDKによる通信が発生します。
完了画面で評価・除外記録を消せます。初回注意を再表示するにはブラウザのサイトデータを削除します。

## ファイル

- index.html：共通の枠、アプリの紹介
- style.css：スマホ375pxを基準にした見た目、PCでは左右2列
- app.js：画面の状態管理、API接続、地図、位置情報、評価
- mock/clarify.json、mock/route.json：新しいAPI仕様の見本
- config.example.js：ブラウザ用設定のひな形
- .gitignore：config.jsを除外（リポジトリ直下の.gitignoreは変更不要）

外部フォント・写真・BGM・アイコンライブラリは使っていません。
図はこの画面用に作成した模式図です。OSMの帰属表示とライセンスリンクを表示します。

## 確認状況と残り

キー・外部APIは使用せず、JS構文、距離・方角、到着判定の精度・鮮度、ID検証、URL/HTMLの扱いを確認しました。
簡易DOMを使い、入力から完了まで、除外、GPSコールバック、評価保存、429復帰、blocked表示を確認しました。
これは実ブラウザの描画検証の代わりにはなりません。

環境の制限で実ブラウザの自動起動とローカルHTTPサーバー起動はできていません。
手元で必要な確認：Chromeでの描画と操作、375px幅、Googleマップ実表示、実API接続、スマホでのGPS。
Google MapsやGeminiの利用規約・料金の適合性をこの画面実装だけで保証するものではありません。

## Gitへ送る

プロジェクト内で、momokaブランチであることと差分を確認してから実行してください。

```bash
git status
git diff -- web/
git add web/
git diff --cached --stat
git diff --cached --name-only
```

`web/config.js`、`.env`、`data/`が含まれていないことを確認してから、

```bash
git commit -m "Add walking app frontend with mock flow"
git push -u origin momoka
```

その後mainへのプルリクエストを作り、相方に確認してもらいます。
