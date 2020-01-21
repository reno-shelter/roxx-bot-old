#!/usr/bin/env bash

# load env
export $(cat .env | xargs)

aws cloudformation deploy \
    --profile saml \
    --region ap-northeast-1 \
    --stack-name roxx-bot \
    --template-file template.yml \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
        Vpc=${VPC_ID} \
        Subnets=${SUBNET_IDS} \
        BotUser=roxx-bot \
        GitHubToken=${githubToken} \
        Auth0Domain=${AUTH0_DOMAIN} \
        Auth0ClientId=${AUTH0_CLIENT_ID} \
        Auth0ClientSecret=${AUTH0_CLIENT_SECRET} \
        Auth0TargetClientId=${AUTH0_TARGET_CLIENT_ID} \
        PreviewenvAuth0ClientId=${PREVIEWENV_AUTH0_CLIENT_ID} \
        PreviewenvAuth0StaffLoginClientId=${PREVIEWENV_AUTH0_STAFF_LOGIN_CLIENT_ID} \
        PreviewenvAuth0StaffManagementClientId=${PREVIEWENV_AUTH0_STAFF_MANAGEMENT_CLIENT_ID} \
        PreviewenvAuth0StaffManagementClientSecret=${PREVIEWENV_AUTH0_STAFF_MANAGEMENT_CLIENT_SECRET} \
        BotEnabled=No
