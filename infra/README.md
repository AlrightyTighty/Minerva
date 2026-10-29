# Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   type-check the project
* `npm run watch`   watch for changes and type-check
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template

## Deploying, and the JWT signing key

The API signs its access tokens with an EC P-256 private key. The key is **passed on the deploy command line**, held
by CloudFormation as a masked parameter, stored in an AWS Secrets Manager secret, and read by the API Lambda when it
starts. It is never written to the template, an environment variable or an output. Keep the original off-cloud.

Make a key once (keep `jwt-key.pem` somewhere safe and out of the repository):

```bash
openssl ecparam -genkey -name prime256v1 | openssl pkcs8 -topk8 -nocrypt > jwt-key.pem
```

Deploy with it as one line of base64 (a PEM has line breaks that are awkward on a command line):

```bash
npx cdk deploy -c alertEmail=you@example.com \
  --parameters BackendStack:JwtPrivateKey="$(base64 < jwt-key.pem | tr -d '\n')"
```

- The deploy **fails** without the parameter, on purpose. There is no default key.
- Pass it on every deploy to be safe. If it is the same key, nothing changes.
- **Rotating the key:** deploy with a new one. Every access token becomes invalid within moments, so people are sent
  to refresh (refresh tokens are not tied to the key, so nobody has to sign in again).
- **If the key leaks**, rotate it at once. Anyone holding it can sign a token for any user.
- To run the API locally, no key is needed: it makes a throwaway one each time it starts, so local tokens stop
  working when the server restarts. Setting `APP_ENV=production` locally needs a real `JWT_KEY_SECRET_ARN`.
