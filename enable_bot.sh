#!/usr/bin/env bash

aws cloudformation deploy \
    --profile saml \
    --region ap-northeast-1 \
    --stack-name roxx-bot \
    --template-file template.yml \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides BotEnabled=Yes
