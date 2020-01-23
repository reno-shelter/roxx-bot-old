#!/usr/bin/env bash

# docker apply
docker-compose build
docker tag roxx-bot_bot:latest 160922217136.dkr.ecr.ap-northeast-1.amazonaws.com/roxx-bot:latest
docker push 160922217136.dkr.ecr.ap-northeast-1.amazonaws.com/roxx-bot:latest

# delete tasks
tasks=$(aws ecs list-tasks \
    --profile saml \
    --cluster roxx-bot \
    --region ap-northeast-1 \
    --query "taskArns[]" \
    --output text)

for task in tasks
do
    aws ecs stop-task \
        --profile saml \
        --task $task
done
