#!/usr/bin/env node

/**
 * Retrieves @mention notifications of the bot user from GitHub,
 * and acts on commands.
 *
 * TODO:
 * - lock notifications so that multiple bot instances don't act on the same command
 * - Use last modified flag to get higher rate limit
 * - paginate notifications (max 100)
 * - success/failure metrics to CloudWatch
 * - handle new changes being pushed to the PR (should update any existing preview environment)
 * - use a config file in the repo to get the right buildspec filename
 * - delete CloudFormation stacks that are in non-updatable states (ROLLBACK_COMPLETE)
 */

const CronJob = require('cron').CronJob;
import AWS = require('aws-sdk');
import octokitlib = require('@octokit/rest');
import {EnvironmentVariable} from "aws-sdk/clients/codebuild";

const codebuild = new AWS.CodeBuild();
const cloudformation = new AWS.CloudFormation();
const ssm = new AWS.SSM();

const githubToken = process.env.githubToken;

const octokit = new octokitlib({
  auth: 'token ' + githubToken
});

const botUser = process.env.botUser || 'roxx-bot';

const region = process.env.AWS_REGION;

// ssm
const activationPeriod = parseInt(process.env.activationPeriod) || 10; // days
const activationRole = process.env.activationRole || 'ssm-activation-role';

const buildProject = process.env.buildProject || 'roxx-bot';

const ecrRepository = process.env.ecrRepository || 'roxx-bot-preview-images';

const triggerCommand = 'preview this';

interface repoConfig {
  [key: string]: {
    owner: string
    repo: string
    baseBranch: string
  }
}

const otherRepoConfig: repoConfig = {
  api: {
    owner: "reno-shelter",
    repo: "backcheck_api",
    baseBranch: "epic/BCP-124/preview_env"
  },
  front: {
    owner: "reno-shelter",
    repo: "backcheck_front",
    baseBranch: "epic/BCP-124/preview_env"
  },
  admin: {
      owner: "reno-shelter",
      repo: "backcheck_admin",
      baseBranch: "dev"
    },
};

const envPrefix = 'PREVIEWENV_';

function timeout(sec: number) {
  return new Promise(resolve => setTimeout(resolve, sec*1000));
}

interface previewStackParam {
  owner: string,
  repo: string,
  prNumber: number,
  requester?: string,
  envs?: EnvironmentVariable[],
  targetOwner?: string,
  targetRepo?: string,
  targetBranch?: string,
  shouldActivation: boolean
}


function buildUniqueId(owner: string, repo: string, prNumber: number, targetRepo?: string) {
  let uniqueId = `${owner}-${repo}-pr-${prNumber}`.replace(/_/, '-');
  if (!!targetRepo) {
    uniqueId += `-${targetRepo}`.replace(/_/, '-');
  }
  return uniqueId;
}

function generateActivationParamName(uniqueId: string) {
  return "preview-env-activation-code-" + uniqueId;
}

async function attachActivationEnv(uniqueId: string, envs: EnvironmentVariable[]) {
  const activationExpiredAt = new Date();
  activationExpiredAt.setDate(activationExpiredAt.getDate() + activationPeriod);

  const activationResponse = await ssm.describeActivations({
    Filters:[
      {
        FilterKey: "DefaultInstanceName",
        FilterValues: [uniqueId]
      }
    ]
  }).promise();
  if(activationResponse.ActivationList.length === 0){
    const activation = await ssm.createActivation({
      DefaultInstanceName: uniqueId,
      Description: "activation for preview env",
      ExpirationDate: activationExpiredAt,
      IamRole: activationRole,
      RegistrationLimit: 5
    }).promise();
    await ssm.putParameter({
      Name: generateActivationParamName(uniqueId),
      Value: activation.ActivationCode,
      Type: "SecureString"
    }).promise();
    envs = envs.concat([
      {
        name: "SSM_ACTIVATION_CODE",
        value: activation.ActivationCode
      },
      {
        name: "SSM_ACTIVATION_ID",
        value: activation.ActivationId
      },
    ]);
    return envs;
  } else {
    const activationCodeResponse = await ssm.getParameter({
      Name: generateActivationParamName(uniqueId),
      WithDecryption: true

    }).promise();
    envs = envs.concat([
      {
        name: "SSM_ACTIVATION_CODE",
        value: activationCodeResponse.Parameter.Value
      },
      {
        name: "SSM_ACTIVATION_ID",
        value: activationResponse.ActivationList[0].ActivationId
      },
    ])
    return envs;
  }
}

/**
 * Stand up a preview environment, including building and pushing the Docker image
 */
async function provisionPreviewStack(params: previewStackParam) {
  const {owner,prNumber,repo,requester,targetBranch,targetOwner,targetRepo, shouldActivation} = params;
  let {envs} = params;
  const isOther: boolean = !!(targetBranch && targetOwner && targetRepo);
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `Ok @${requester}, I am provisioning a preview stack to ${targetRepo}`
  });

  // start a build to build and push the Docker image, plus synthesize the CloudFormation template
  console.log('INFO: set unique id');

  const uniqueId = buildUniqueId(owner, repo, prNumber, targetRepo);
  const sourceVersion = targetBranch? targetBranch : 'pr/' + prNumber;
  const sourceLocationOverride = isOther ? `https://github.com/${targetOwner}/${targetRepo}` : `https://github.com/${owner}/${repo}`;


  if (shouldActivation) {
    console.log('INFO: create activation');
    envs = await attachActivationEnv(uniqueId, envs);
  }

  console.log('INFO: start build');
  const startBuildResponse = await codebuild.startBuild({
    projectName: buildProject,
    sourceVersion,
    sourceLocationOverride,
    buildspecOverride: 'buildspec.yml',
    cacheOverride: {
      type: "LOCAL",
      modes: [
        "LOCAL_DOCKER_LAYER_CACHE"
      ]
    },
    environmentVariablesOverride: [
      ...envs,
      {
        name: "UNIQUE_ID",
        value: uniqueId
      },
      {
        name: "IMAGE_REPO_NAME",
        value: ecrRepository
      },
      {
        name: "IMAGE_TAG",
        value: uniqueId
      }
    ]
  }).promise();
  console.log('INFO: set build id');
  const buildId = startBuildResponse.build.id;
  console.log('INFO: set build url');
  const buildUrl = `https://console.aws.amazon.com/codesuite/codebuild/projects/${buildProject}/build/${buildId}/log?region=${region}`;

  console.log('INFO: send comment about start build');
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `I started build [${buildId}](${buildUrl}) for the preview stack`
  });

  // wait for build completion
  for(let i = 0; i < 150; i++) {
    console.log('INFO: check complete build');
    const response = await codebuild.batchGetBuilds({
      ids: [buildId]
    }).promise();

    if (response.builds[0].buildComplete) {
      break;
    }

    await timeout(5);
  }

  console.log('INFO: set build response');
  const buildResponse = await codebuild.batchGetBuilds({
    ids: [buildId]
  }).promise();
  console.log('INFO: set build result');
  const buildResult = buildResponse.builds[0];

  if (buildResult.buildStatus != 'SUCCEEDED') {
    console.error("Build status: " + buildResult.buildStatus);
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: `Build [${buildId}](${buildUrl}) failed`
    });
    return;
  }

  console.log('INFO: send comment about build success');
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `Build [${buildId}](${buildUrl}) succeeded. I am now provisioning the preview stack ${uniqueId}`
  });

  // get the template from the build artifact
  console.log('INFO: set s3 location');
  const s3Location = buildResult.artifacts.location + "/template.yml";
  console.log('INFO: set s3 url');
  const s3Url = s3Location.replace('arn:aws:s3:::', 'https://s3.amazonaws.com/');

  // create or update CloudFormation stack
  let stackExists = true;
  try {
    console.log('INFO: describe cloud formation stack');
    await cloudformation.describeStacks({
      StackName: uniqueId
    }).promise();
  } catch(err) {
    if (err.message.endsWith('does not exist')) {
      stackExists = false;
    } else {
      throw err;
    }
  }

  if (stackExists) {
    try {
      console.log('INFO: update cloud formation stack');
      await cloudformation.updateStack({
        StackName: uniqueId,
        TemplateURL: s3Url,
        Capabilities: ["CAPABILITY_IAM"]
      }).promise();
      console.log('INFO: wait for cloud formation stack');
      await cloudformation.waitFor("stackUpdateComplete", { StackName: uniqueId }).promise();
    } catch(err) {
      if (!err.message.endsWith('No updates are to be performed.')) {
        throw err;
      }
    }
  } else {
    console.log('INFO: create cloud formation stack');
    await cloudformation.createStack({
      StackName: uniqueId,
      TemplateURL: s3Url,
      Capabilities: ["CAPABILITY_IAM"]
    }).promise();
    console.log('INFO: wait for cloud formation stack');
    await cloudformation.waitFor("stackCreateComplete", { StackName: uniqueId }).promise();
  }

  console.log('INFO: describe cloud formation stack');
  const stackResponse = await cloudformation.describeStacks({
    StackName: uniqueId
  }).promise();
  console.log('INFO: set cloud formation stack status');
  const stackStatus = stackResponse.Stacks[0].StackStatus;
  console.log('INFO: set cloud formation stack arn');
  const stackArn = stackResponse.Stacks[0].StackId;
  console.log('INFO: set cloud formation stack url');
  const stackUrl = `https://console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/${encodeURIComponent(stackArn)}/overview`;

  if (stackStatus != "CREATE_COMPLETE" && stackStatus != "UPDATE_COMPLETE") {
    console.error("Stack status: " + stackStatus);
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: `Preview stack creation [${uniqueId}](${stackUrl}) failed`
    });
  } else {
    console.log('INFO: set comment body');
    let body = `@${requester} preview stack creation [${uniqueId}](${stackUrl}) succeeded!`;
    for (const output of stackResponse.Stacks[0].Outputs) {
      console.log('INFO: set comment value');
      const value = output.OutputValue.endsWith('elb.amazonaws.com') ? `http://${output.OutputValue}` : output.OutputValue;
      console.log('INFO: apply comment value to comment body');
      body += `\n\n${output.OutputKey}: ${value}`;
    }
    console.log('INFO: send comment about preview stack create succeeded');
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body
    });
  }
}

/**
 * Tear down when the pull request is closed
 */
async function cleanupPreviewStack(param: previewStackParam) {
  const {owner, repo, prNumber, targetRepo, shouldActivation} = param;
  // Delete the stack
  const uniqueId = buildUniqueId(owner, repo, prNumber, targetRepo);
  let stackExists = true;
  try {
    await cloudformation.describeStacks({
      StackName: uniqueId
    }).promise();
  } catch(err) {
    if (err.message.endsWith('does not exist')) {
      stackExists = false;
    } else {
      throw err;
    }
  }

  if (!stackExists) {
    console.log("Ignoring because preview stack does not exist");
    return;
  }

  await octokit.issues.createComment({
    owner,
    repo,
    number: prNumber,
    body: "Now that this pull request is closed, I will clean up the preview stack"
  });

  await cloudformation.deleteStack({ StackName: uniqueId }).promise();
  await cloudformation.waitFor("stackDeleteComplete", { StackName: uniqueId }).promise();

  // Confirm stack is deleted
  stackExists = true;
  try {
    const stackResponse = await cloudformation.describeStacks({
      StackName: uniqueId
    }).promise();
    console.log("Stack status: " + stackResponse.Stacks[0].StackStatus);
    stackExists = stackResponse.Stacks[0].StackStatus != 'DELETE_COMPLETE';
    if(shouldActivation){
      const activationResponse = await ssm.describeActivations({
        Filters: [
          {
            FilterKey: "DefaultInstanceName",
            FilterValues: [uniqueId]
          }
        ]
      }).promise();
      await Promise.all(activationResponse.ActivationList.map(activation => {
        return ssm.deleteActivation({
          ActivationId: activation.ActivationId
        }).promise()
      }));
      await ssm.deleteParameter({
        Name: generateActivationParamName(uniqueId)
      })
    }
  } catch(err) {
    if (err.message.endsWith('does not exist')) {
      stackExists = false;
    } else {
      throw err;
    }
  }

  if (!stackExists) {
    await octokit.issues.createComment({
      owner,
      repo,
      number: prNumber,
      body: "I successfully cleaned up the preview stack"
    });
  } else {
    console.error("TheStack failed to delete");
    await octokit.issues.createComment({
      owner,
      repo,
      number: prNumber,
      body: `The preview stack ${uniqueId} failed to clean up`
    });
  }
}

function getShouldActivation(repo: string) {
  return repo === 'backcheck_api';
}

/**
 * Determine the action associated with this notification
 */
async function handleNotification(notification: octokitlib.ActivityListNotificationsResponseItem) {
  // Mark the notification as read
  await octokit.activity.markThreadAsRead({
    thread_id: parseInt(notification.id, 10)
  });

  // Validate the notification
  if (notification.reason != 'mention') {
    console.log("Ignoring because reason is not mention: " + notification.reason);
    return;
  }

  if (notification.subject.type != 'PullRequest') {
    console.log("Ignoring because type is not PullRequest: " + notification.subject.type);
    return;
  }

  // Format: https://api.github.com/repos/<owner>/<repo>/pulls/<pull request id>
  const pullRequestsUrl = notification.subject.url;
  let parts = pullRequestsUrl.replace('https://api.github.com/', '').split('/');
  const owner = parts[1];
  const repo = parts[2];
  const prNumber = parseInt(parts[4], 10);
  const pullRequestResponse = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber
  });

  const shouldActivation = getShouldActivation(repo);

  console.log('pullRequestResponse: ');
  console.log(pullRequestResponse);
  if (pullRequestResponse.data.state == 'closed') {
    console.log("Cleaning up preview stack");
    await Promise.all(
        Object.keys(otherRepoConfig).map(target => {
          if(otherRepoConfig[target].repo === repo){
            return cleanupPreviewStack({owner, repo, prNumber, shouldActivation})
          }
          return cleanupPreviewStack({owner, repo,prNumber,targetRepo: otherRepoConfig[target].repo, shouldActivation})
        })
    );
    return;
  } else {
    // Format: https://api.github.com/repos/<owner>/<repo>/issues/comments/<comment id>
    // TODO only getting the latest comment every minute means that some mentions might
    // be missed if someone else comments on the PR before the polling interval
    const commentUrl = notification.subject.latest_comment_url;

    if (commentUrl == pullRequestsUrl) {
      console.log("Ignoring because there were no new comments");
      return;
    }

    parts = commentUrl.replace('https://api.github.com/', '').split('/');
    const comment_id = parseInt(parts[5], 10);
    const commentResponse = await octokit.issues.getComment({
      owner,
      repo,
      comment_id
    });

    console.log('commentResponse');
    console.log(commentResponse);
    const commentBody = commentResponse.data.body;
    if (!commentBody.includes('@' + botUser)) {
      console.log("Ignoring because comment body does not mention the comment body: " + commentBody);
      return;
    }

    const requester = commentResponse.data.user.login;
    const command = commentBody.replace('@' + botUser, '').trim();
    if (command.includes(triggerCommand)) {
      console.log("Provisioning preview stack");
      const envs = parseEnv(command, triggerCommand);
      await provisionPreviewStack({owner, repo, prNumber, requester, envs, shouldActivation});
    } else if(command.startsWith("preview")) { // それ以外の環境
      const target = command.replace(/preview (front|api).*/, "$1");
      const envs = parseEnv(command, `preview ${target}`);
      if (otherRepoConfig[target] == undefined) {
        console.log(`command cannot deploy [${target}]`);
        return;
      }
      const targetConfig = otherRepoConfig[target];
      await provisionPreviewStack({
        owner,
        repo,
        prNumber,
        requester,
        envs,
        targetRepo: targetConfig.repo,
        targetBranch: targetConfig.baseBranch,
        targetOwner: targetConfig.owner,
        shouldActivation,
      });
    } else {
      console.log("Ignoring because command is not understood: " + command);
      return;
    }
  }
}

function parseEnv(command: string, trigger: string): EnvironmentVariable[] {
  return command
      .replace(trigger, '').trim()
      .replace(/ +/, ' ') //空白を除去
      .split(' ')
      .reduce((previousValue: EnvironmentVariable[], envString: string) => {
        const [name, value] = envString.split('=');
        if (!name || !value) return previousValue;
        previousValue.push({
          name,
          value
        });
        return previousValue;
      }, [])
      // 識別可能な用にENVにプレフィックスをつける
      .map(envs => envs && ({
        name: envPrefix + envs.name,
        value: envs.value
      }))
}

/**
 * Retrieve notifications from GitHub and filter to those handled by this bot
 */
async function retrieveNotifications() {
  // console.log("Retrieving notifications: " + (new Date()).toISOString());

  try {
    // Retrieve latest unread notifications
    const since = new Date();
    since.setHours(since.getHours() - 1); // last hour

    let response;
    try {
      response = await octokit.activity.listNotifications({
        all: false, // unread only
        since: since.toISOString(),
        participating: true, // only get @mentions
      });
    } catch(err) {
      // TODO Assume this is a 304 Not Modified for now, check explicitly later
      console.log('Errors: ');
      console.log(err);
      console.log("No new notifications");
      return true;
    }
    // console.log('Response: ');
    // console.log(response);
    const notifications = response.data;

    // console.log("Notifications: " + notifications.length);
    for (const notification of notifications) {
        // console.log('Notifications:');
        // console.log(notification);
      await handleNotification(notification);
    }
  } catch(err) {
    console.error(err);
    return false;
  }

  return true;
}

retrieveNotifications().then((success) => {
  if (success) {
    // poll every 30 seconds
    console.log("Scheduling jobs");
    const job = new CronJob('*/30 * * * * *', retrieveNotifications);

    process.on('SIGTERM', () => {
      console.info('SIGTERM signal received.');
      job.stop();
    });
    process.on('SIGHUP', () => {
      console.info('SIGHUP signal received.');
      job.stop();
    });
    process.on('SIGINT', () => {
      console.info('SIGINT signal received.');
      job.stop();
    });

    job.start();
  }
});
