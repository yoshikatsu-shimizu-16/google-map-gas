# 現在のワークフロー(実行順)

①②⑤は基本1回きりの準備、④(`crawlAllGrids`)だけが日次トリガーで永続的にループし続ける実行部分。
④は実行のたびに②の調査結果(「調査(マス)」シート)だけを読み込み、答えが分かっている「0件」「飽和」マスへの
APIコールを自動でスキップする。

③(`surveySaturatedCells`/`surveyEmptyCells`)は②の結果のうち「20件以上(飽和)だったマス」や
「0件と予測されたマス」だけを対象にした補助調査で、結果は`調査(分割マス)`/`調査ログ`シートに残るのみ。
④はここを読まないため、③の結果は自動反映されない(人間が見るための調査ログ)。

```mermaid
flowchart TD
    A["① generateGridList<br/>座標リスト作成(初回のみ)"] --> B["② surveyAllCells<br/>全マス調査(Pro枠、繰返し可)"]
    B --> C["③ 補助調査(任意)<br/>surveySaturatedCells / surveyEmptyCells<br/>※結果は調査ログのみ、④には反映されない"]
    B --> E["⑤ createDailyTrigger<br/>日次トリガー設定(初回のみ)"]
    E --> D["④ crawlAllGrids<br/>本番収穫(Enterprise枠)"]
    D -->|日次トリガーで毎日繰り返す| D
    B -.「調査(マス)」を毎回読み込み<br/>0件/飽和マスは自動スキップ.-> D
```
