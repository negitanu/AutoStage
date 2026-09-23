# AutoStage

Stagehand v4、ローカル生成モデル（Qwen / Gemma）または OpenRouter、Laya を組み合わせた Web アプリの機能回帰テストツールです。ダーク基調のワークベンチでシナリオの作成、実行、ステップごとの画面確認、履歴の調査を行います。

## 起動

必要なもの: Node.js 22.18 以上、Google Chrome。`npm install` は開発用 Node.js 22 もプロジェクト内に導入するため、`npm run` はそのバージョンを利用します。Chrome の既存プロフィールは使いません。

```sh
npm install
npm run dev
```

UI: http://127.0.0.1:5173 / API: http://127.0.0.1:4310

左側の「ログインフロー」または「プロジェクト検索」を選び「テストを実行」すると、付属の Forma サンプルアプリに対して **実際の Stagehand / Chrome** が動きます。この２つのシナリオはモデルを必要としません。

配布用ビルドを使う場合:

```sh
npm run build
npm start
```

この場合、UI と API は http://127.0.0.1:4310 です。

## Docker Compose で起動

Docker Engine と Compose が使える環境で、プロジェクトのルートから実行します。

```sh
docker compose up --build -d
```

http://127.0.0.1:4310 を開いてください。アプリ用コンテナに Chromium / Stagehand v4、もう一方に Laya を配置します。Laya は初回起動時にモデルを取得するため、判定が使えるまで時間がかかります。状態は設定画面の「接続確認」または `docker compose logs -f laya` で確認できます。

設定・実行履歴・スクリーンショット・保存済みの OpenRouter API キーは `autostage_data` ボリューム、Laya のモデルは `laya_models` ボリュームに保持します。`docker compose down` では消えません。停止は `docker compose down` です。Docker とローカル実行のデータは別々です。

既定では API をホストの `127.0.0.1:4310` だけに公開します。OpenRouter を使う場合は UI の「設定」で接続先、モデル ID、API キーを保存してください。環境変数 `OPENROUTER_API_KEY` を Compose に渡す方法も使えます。ホストで起動した Ollama / LM Studio を使う場合、モデルの API ベース URL は `http://host.docker.internal:11434/v1`（Ollama）などにします。コンテナ内の `127.0.0.1` はホストではなくアプリのコンテナを指します。

Compose 初回起動時の Laya URL は `http://laya:8001` に設定されます。既存のボリュームで設定を保存済みの場合は、その保存済み設定が優先されます。ローカル実行から Docker に切り替えた際は設定画面で接続先を確認してください。

## Qwen / Gemma の接続

[Ollama](https://ollama.com/) をインストールして起動し、実行するモデルを取得します。モデルサイズはマシンのメモリに合わせて選択してください。

```sh
ollama serve
# 別のターミナルで
ollama pull qwen3:8b
# または
ollama pull gemma3:12b
```

UI の「設定」で以下を保存してください。

- API ベース URL: `http://127.0.0.1:11434/v1`
- モデル名: `qwen3:8b` または取得したモデル名

LM Studio の OpenAI 互換サーバーも使えます（例: `http://127.0.0.1:1234/v1`）。**JSON Schema による構造化出力**に対応するモデルとサーバーが必要です。「接続済み」はモデル一覧で存在を確認した状態であり、操作精度を保証するものではありません。

Stagehand v4 の `model.generate` コールバックから、ローカルの `/chat/completions` にメッセージと出力スキーマを渡します。クラウドへのフォールバックはありません。推論にスクリーンショットは送らず、DOM / テキストを用います。ローカル接続の接続先は loopback アドレスに限定しています。

## OpenRouter の接続

「設定」→「接続先」で **OpenRouter · Cloud API** を選び、API キーとモデル ID（例: `openai/gpt-4o-mini`）を入力して保存します。JSON Schema の構造化出力に対応するモデルが必要です。ローカルモデルの設定は別に保持され、いつでも切り替えられます。

接続確認では `/key` で認証を確認し、モデル一覧の `structured_outputs` 対応を検証します。接続確認では推論しません。実行時は `https://openrouter.ai/api/v1/chat/completions` に Bearer 認証で接続し、`provider.require_parameters: true` と厳密な JSON Schema を指定します。

API キーはサーバーの `.data/credentials.json` に所有者のみ読み書きできる権限（0600）で保存します。このファイルは暗号化されていません。SQLite・実行履歴・エクスポートには含めず、保存済みのキーを UI に返すこともありません。空欄で保存すると既存のキーを保持し、「保存時に API キーを削除」で削除できます。サーバーの環境変数 `OPENROUTER_API_KEY` でも指定でき、環境変数が保存済みのキーより優先されます。`.env` の自動読み込みは行いません。

OpenRouter 選択時の AI 操作は、観測した DOM / テキストと操作指示を OpenRouter およびモデル提供者に送信し、API 利用料が発生します。スクリーンショットはモデルに送信しません。ブラウザ実行と Laya の意味判定は引き続きローカルです。

## Laya の接続

Python 3.12 と [uv](https://docs.astral.sh/uv/) を推奨します。

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r services/laya/requirements.txt
.venv/bin/uvicorn services.laya.app:app --host 127.0.0.1 --port 8001
```

初回は公開モデルを Hugging Face から `.data/huggingface/` に取得します。英語・多言語モデルを読み込んでから ready になります。起動中の状態は `/health` または UI の「接続確認」で確認できます。取得後の推論はローカルです。CPU を既定にし、GPU を使う場合は `LAYA_DEVICE` を明示的に指定できます。

「Laya 意味判定」ステップに期待条件と対象 CSS セレクターを指定すると、可視テキストを Laya の `noul` 判定に渡します。既定のしきい値は次のとおりです。

- 確率 85% 以上: 成功
- 確率 15% 以下: 失敗
- その中間: 要確認

対象文と指示がモデルの文脈長に収まらない場合は、切り詰めずにエラーにします。セレクターで必要な内容に絞ってください。モデルの確率は正しさの保証ではありません。URL・テキスト・表示の厳密な検証も併用してください。

両方を接続すると、付属の「AI でログインを検証」を実行できます。自然言語操作は選択した生成モデル、ログイン後の意味判定は Laya が担当します。

## シナリオと結果

- ページ遷移、CSS セレクターによるクリック・入力、自然言語による AI 操作。
- テキストの包含、URL の完全一致、要素の表示、Laya の意味判定。
- ステップの追加・編集・並べ替え、シナリオの複製・削除・検索。
- 毎回新しい Chrome プロフィールを使用。実行はキューで直列処理。
- ステップごとの PNG、ログ、判定テキスト、確率、実行時間を保存。
- 失敗で後続ステップをスキップ。「要確認」は後続の検証を続行。
- 実行開始時点のシナリオ・モデル・しきい値を保存。後から編集しても過去の履歴は変わりません。
- 実行停止、サーバー再起動時の中断処理、実行上限、JSON レポート出力。
- `⌘ / Ctrl + Enter`: 実行、`⌘ / Ctrl + K`: 検索、`⌘ / Ctrl + ,`: 設定。

画像は実行の証跡です。画像差分による判定は今回の機能回帰テスト版には含めていません。

入力値、画面、観測テキストは `.data/` に平文で保存されます。実アカウントの秘密情報を含むシナリオやレポートは、ローカルデータとして管理してください。外部 Web アプリへのアクセスは、登録したテスト対象への通常のブラウザ通信です。

## 構成

- `src/`: React / TypeScript のワークベンチ
- `server/index.ts`: ローカル Express API、SSE、直列の実行キュー
- `server/worker.ts`: 別プロセスの Stagehand v4 ブラウザ実行
- `server/model.ts`: ローカル / OpenRouter の生成モデルアダプターと確率判定
- `server/store.ts`: SQLite 永続化
- `services/laya/app.py`: Python / FastAPI / Laya 判定サービス
- `shared/schema.ts`: 共通型・入力バリデーション
- `public/demo/`: 検証用サンプルアプリ

ローカル実行時のデータは `.data/autostage.sqlite` と `.data/artifacts/` に保存します。`AUTOSTAGE_DATA_DIR` で変更できます。`CHROME_PATH` で Chrome のパス、`PORT` で API ポートを変更できます。開発 UI の proxy は `vite.config.ts` の 4310 が既定なので、API ポートを変える場合は合わせて変更してください。

## 検証

```sh
npm test              # バリデーション、モデル HTTP 変換、Laya しきい値
npm run test:browser  # 実 Chrome と隔離した API / SQLite を使う結合テスト
npm run build        # TypeScript と本番ビルド
```

ブラウザ結合テストは 4312 ポートを使い、ログイン、検索、PNG 保存、意図的な失敗、タイムアウト、後続スキップ、キャンセル、履歴不変性、エクスポート、Origin 制御を検証します。Stagehand の `act` → ローカル OpenAI 互換 API → 実ブラウザのクリックという経路も検証します。生成モデルの応答と Laya の不確かな判定を再現する部分は、明示した HTTP フィクスチャを使用します。本番機能にはモックの実行モードはありません。

実モデルでの確認: Laya 0.3.5 で英語・日本語の推論と、文脈長超過時に切り詰めず拒否する動作を確認しました。起動済みの Laya に対して `.venv/bin/python scripts/check-laya.py` で再検証できます。Qwen / Gemma の実推論はモデルを別途起動して確認してください。OpenRouter の認証・構造化出力要求・エラー処理はフィクスチャで検証しています。実 API キーを用いた有料推論は未検証です。

## 参照

- [Stagehand v4 documentation](https://docs.stagehand.dev/v4/first-steps/quickstart)
- [Laya](https://github.com/NandhaKishorM/laya)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)

- [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [OpenRouter API key verification](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)
