#!/usr/bin/env bash

# docker apply
ECR_REPO=$(aws ecr describe-repositories \
    --profile saml \
    --region ap-northeast-1 \
    --repository-names roxx-bot \
    --output text \
    --query 'repositories[0].repositoryUri')
echo $ECR_REPO

$(aws ecr get-login \
    --profile saml \
    --no-include-email \
    --region ap-northeast-1)

docker build -t roxx-bot .
docker tag roxx-bot $ECR_REPO
docker push $ECR_REPO

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
