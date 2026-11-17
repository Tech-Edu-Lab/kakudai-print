# 同梱しているライブラリ

外部への通信をなくすため、次のライブラリをそのまま同梱しています。

| ファイル | ライブラリ | 版 | ライセンス |
|---|---|---|---|
| `pdf-lib.min.js` | [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT |
| `fontkit.umd.min.js` | [@pdf-lib/fontkit](https://github.com/Hopding/fontkit) | 1.1.1 | MIT |
| `pdf.min.js`, `pdf.worker.min.js` | [PDF.js](https://github.com/mozilla/pdf.js) | 3.11.174 | Apache-2.0 |

各ファイルは、文字列の中にそのまま入っていた制御文字と U+FFFD を、同じ意味のエスケープ表記（`\x1b`、`\uFFFD` など）に置き換えています。動作は同じで、それ以外は配布物のままです。
