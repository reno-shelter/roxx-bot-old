# ROXX-bot

ROXX-botはbackcheckのプレビュー環境を構築するbotです。

## 使い方
### 概要
だいたいの概要を掴んでもらうための説明です。(**※正常に動作させるにはオプションが必要です**)  
実際に使用する際はユースケースを参照してください。

1. GitHub上でプルリクエストを作成します。
1. プルリクエスト上で「`@roxx-bot preview this`」とコメントします。
1. roxx-botさんがちょこちょことコメントを残していきます。(最長で30秒ほどかかります)
1. しばらく経つとそのプルリクエスト(=base branch)のコードが反映された環境が立ち上がり、URLが表示されます。(だいたい2分ほどかかります)

    ![](./docs/assets/success_comment.png)

1. backcheckの環境は1リポジトリでは完結しないので、もう一方の環境を立ち上げます。

    つまり、backcheck_apiのプルリクエストであればfrontを、backcheck_frontのプルリクエストであればapiのプレビュー環境を立ち上げます。

    1. 「`@roxx-bot preview front`」または「`@roxx-bot preview front`」とコメントします。

1. しばらく経つとそのプルリクエスト(=base branch)のコードが反映された環境が立ち上がり、URLが表示されます。(だいたい2分ほどかかります)

    ![](./docs/assets/success_comment.png)

1. URLのリンクを踏むとプレビュー環境を見ることができます。

### ユースケース

#### APIのみのプレビュー環境
1. `@roxx-bot preview this`
1. `@roxx-bot preview front`

#### FRONTのみのプレビュー環境
1. `@roxx-bot preview this`
1. `@roxx-bot preview api`

#### APIとFRONTの複合プレビュー環境
1. APIとFRONTでそれぞれプルリクエストを作成する
1. API側のプルリクエストでFRONTのURLをつけた状態でコメントする

    `@roxx-bot preview this https://github.com/reno-shelter/backcheck_front/pull/XXXX`

1. FRONT側のプルリクエストでAPIのURLをつけた状態でコメントする

    `@roxx-bot preview this https://github.com/reno-shelter/backcheck_api/pull/XXXX`

## FAQ
### adminは？
未対応です。

### プレビュー環境の効期限は？
プルリクエストのステータスが `Closed` または `Merged` になると破棄されます。

## 開発者用ガイド
[こちら](docs/README_dev.md)を参照してください。
