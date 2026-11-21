---
title: 'How to pay for GitHub Actions with your AWS, GCP or Azure credits'
description: GitHub bills Actions minutes to a card, an invoice or an Azure subscription, so AWS and Google Cloud credits can't pay for GitHub-hosted runners. What each startup credit program covers, how committed spend counts, and how to run CI on spot VMs your credits pay for.
date: 2026-11-18
lastUpdated: 2026-11-18
authors: backmesh
tags:
  - Cloud credits
excerpt: AWS Activate and Google for Startups credits can't pay GitHub's bill, and Microsoft for Startups credits can only through an Azure subscription link. Running GitHub Actions on self-hosted runners in your own cloud account puts CI on the bill your credits already pay. Program terms, committed spend, and worked numbers.
head:
  - tag: title
    content: 'Use AWS, GCP or Azure credits for GitHub Actions (2026) | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@graph":[{"@type":"BlogPosting","headline":"How to pay for GitHub Actions with your AWS, GCP or Azure credits","datePublished":"2026-11-18","dateModified":"2026-11-18","author":{"@type":"Organization","name":"backmesh","url":"https://backmesh.com/"},"publisher":{"@id":"https://backmesh.com/#organization"},"mainEntityOfPage":"https://backmesh.com/blog/github-actions-cloud-credits/"},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Can I use AWS credits for GitHub Actions?","acceptedAnswer":{"@type":"Answer","text":"Not for GitHub-hosted runners. GitHub''s supported payment methods are invoice, credit card, PayPal, ACH and an Azure subscription, and GitHub Enterprise has not been sold through AWS Marketplace since 2021-05-12. AWS credits can pay for EC2 instances that run your jobs as self-hosted runners."}},{"@type":"Question","name":"Can I use Google Cloud credits for GitHub Actions?","acceptedAnswer":{"@type":"Answer","text":"Not for GitHub-hosted runners, since GitHub has no Google Cloud payment option. Google for Startups credits apply to first-party Google Cloud products billed pay-as-you-go, which includes the Compute Engine VMs that self-hosted runners use."}},{"@type":"Question","name":"Can Microsoft for Startups credits pay for GitHub Actions?","acceptedAnswer":{"@type":"Answer","text":"Yes, per Microsoft''s startup docs, once you connect your Azure sponsorship subscription to GitHub as a payment method. GitHub then bills eligible usage-based services, including Actions, against the credits. The credits can also pay for Azure VMs that run self-hosted runners."}},{"@type":"Question","name":"Do startup credits cover spot or preemptible VMs?","acceptedAnswer":{"@type":"Answer","text":"As of 2026-11-18, AWS''s promotional credit exclusions don''t name EC2 or Spot Instances, Google''s credits cover first-party pay-as-you-go products such as Compute Engine, and Azure lists the Sponsored offer (0036P) as supporting Spot VMs. Check the terms of your own award."}},{"@type":"Question","name":"Does GitHub spend count toward an Azure MACC?","acceptedAnswer":{"@type":"Answer","text":"Yes, when it is billed through a connected Azure subscription. GitHub''s docs say the GitHub products on your Azure invoice are MACC-eligible. Usage that Azure credits cover does not count toward a MACC."}},{"@type":"Question","name":"Does GitHub spend count toward an AWS EDP or private pricing commitment?","acceptedAnswer":{"@type":"Answer","text":"GitHub has no AWS billing route, so GitHub-hosted minutes can''t count. EC2 instances running self-hosted runners are ordinary AWS usage on your AWS bill. Whether a given service counts is set in your private agreement."}},{"@type":"Question","name":"How long would cloud credits last for CI?","acceptedAnswer":{"@type":"Answer","text":"By backmesh''s arithmetic with spot prices from 2026-11-13, 150,000 minutes a month of 4-vCPU jobs cost about $206 to $365 a month at the high end of each cloud, always-on VMs included. $5,000 lasts about 14 to 24 months at that rate, against under 3 months on GitHub-hosted 4-core runners at $1,800 a month."}},{"@type":"Question","name":"Do I need to change my workflows?","acceptedAnswer":{"@type":"Answer","text":"Only the runs-on line. With backmesh, runs-on: ubuntu-latest becomes runs-on: backmesh-4 for a 4-vCPU spot VM. backmesh runs Linux x86-64 jobs only, in private repositories unless you turn on public repositories with --public-repos."}},{"@type":"Question","name":"Does GitHub charge for self-hosted runners?","acceptedAnswer":{"@type":"Answer","text":"Not as of 2026-11-18. GitHub announced a $0.002 per minute charge for self-hosted runners in private repositories on 2025-12-16 and postponed it the next day, with no new date."}}]}]}'
---

You can't pay GitHub with AWS or Google Cloud credits. GitHub bills Actions
minutes to a card, PayPal, ACH, an invoice or an Azure subscription, and
nothing else. Microsoft for Startups credits are the one exception: connect
the sponsored Azure subscription to GitHub and Actions usage draws down the
credits. For AWS and GCP credits, the way to use them for CI is to run your
jobs on self-hosted runners in your own cloud account. The VMs then appear on
the cloud bill your credits already pay, and GitHub charges nothing for
self-hosted minutes today.

Every figure below links to its source and was checked on 2026-11-18. Credit terms change often, and many awards carry
their own terms, so check yours before you plan around any figure here.

## Why GitHub-hosted minutes sit outside your credits

GitHub-hosted runners are GitHub's machines, billed by GitHub. GitHub's
[Actions billing docs](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
say usage beyond the included amount is billed to the payment method on your
GitHub account. Its list of
[supported payment methods](https://docs.github.com/en/billing/reference/supported-payment-methods)
has five entries:

| Payment method        | Who can use it                                                   |
| --------------------- | ---------------------------------------------------------------- |
| Invoice               | Managed accounts only                                            |
| Credit card           | Unmanaged accounts, or as a nonrecurring method for managed ones |
| PayPal                | Unmanaged accounts, or as a nonrecurring method for managed ones |
| Azure Subscription ID | Organizations and enterprises, not personal accounts             |
| ACH                   | Managed accounts only                                            |

There's no AWS or Google Cloud entry. GitHub Enterprise was once listed on
AWS Marketplace, but GitHub added a note to its
[announcement](https://github.blog/news-insights/product-news/github-enterprise-now-available-from-the-aws-marketplace/)
on 2021-05-12 saying it is "no longer available for purchase through the AWS
Marketplace". An AWS credit balance or an AWS commitment can't reach GitHub's
bill, and the same goes for Google Cloud.

### The Azure route

An org owner can
[connect an Azure subscription](https://docs.github.com/en/billing/how-tos/set-up-payment/connect-azure-sub)
to pay for "metered usage of GitHub features through Azure". Actions is on
GitHub's list of usage-based products, so minutes over the included amount
go to the Azure invoice, charged on the 1st of each month
([Azure subscription payments](https://docs.github.com/en/billing/concepts/azure-subscriptions)).
These limits apply.

- It needs tenant-wide admin consent in Microsoft Entra, and owner rights on
  the Azure subscription.
- Free trial, Azure for Students, Azure Pass, MSDN and several pay-as-you-go
  offer types can't be used. GitHub lists them by offer number.
- If you pay GitHub through a volume or prepaid agreement, that billing
  continues until the agreement expires.
- Prepaid usage isn't available for usage-based billing through Azure.

Microsoft's startup docs, updated 2026-11-04, go further. They say
[GitHub usage isn't covered by startup credits by default](https://learn.microsoft.com/en-us/startups/build/getting-started/use-startup-credits),
but once you connect your Azure subscription as a payment method in GitHub,
"GitHub bills eligible usage against your startup credits", with GitHub
Actions in the table of eligible services. So a Microsoft for Startups
balance can pay for GitHub-hosted minutes, at GitHub's list price of $0.012 a
minute for a Linux 4-core runner.

## What the startup programs offer

Each program's own pages, read on 2026-11-18:

| Program                                                                                                           | Amounts                                                                                                    | Expiry                                                     | Covers VMs?                                           | Spot / preemptible                               |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------ |
| [AWS Activate](https://aws.amazon.com/aws-startups/learn/everything-you-need-to-know-about-aws-activate-credits/) | Founders $1,000, select startups up to $5,000 over time; Portfolio up to $200,000 for provider-backed ones | "Usually expire within 1-2 years depending on the package" | Yes, over 200 eligible services                       | EC2 and Spot aren't on the exclusion list        |
| [Google for Startups Cloud Program](https://cloud.google.com/startup)                                             | Start $2,000; Scale and Scale AI $200,000 to $350,000 over two years                                       | Two years, with year 2 at 20% coverage                     | First-party pay-as-you-go products, so Compute Engine | Not named; Spot VMs bill as Compute Engine usage |
| [Microsoft for Startups](https://www.microsoft.com/en-us/startups)                                                | Up to $5,000 through business verification, up to $150,000 over time                                       | Activate within 90 days, then two years to use             | Yes, Azure Virtual Machines are listed                | The Sponsored offer (0036P) supports Spot VMs    |

### AWS Activate

AWS's
[promotional credit terms](https://aws.amazon.com/awscredits/), last updated
2026-09-24, exclude AWS Marketplace, Mechanical Turk, Managed Services,
Professional Services, training, Route 53 domains, some support plans, and
upfront fees for Savings Plans and Reserved Instances. EC2 usage, on demand
or spot, isn't on that list. Unredeemed credit is forfeited at expiry, and
expired credit isn't refunded.

### Google for Startups Cloud Program

Google's footnotes split the Scale tiers by year.
Year 1 covers 100% of eligible usage up to $100,000, or $250,000 for AI
startups. Year 2 covers 20% of eligible usage, up to another $100,000. In year
2 you pay 80% of the bill yourself. The
[program page](https://cloud.google.com/startup) limits credits to Google-built
products "billed on a pay-as-you-go (PayG) or consumption basis" and excludes
subscription products and everything in Google Cloud Marketplace.

### Microsoft for Startups

The credits sit on an
[Azure sponsorship subscription](https://azure.microsoft.com/pricing/offers/ms-azr-0036p/)
and cover Azure services billed at published pay-as-you-go rates. Support
plans, third-party models, partner services and Marketplace purchases aren't
covered. Microsoft's
[billing FAQ](https://learn.microsoft.com/en-us/startups/build/getting-started/azure-usage-and-billing)
says you have two years from activation, with no extensions. Azure's
[Spot VM docs](https://learn.microsoft.com/en-us/azure/virtual-machines/spot-vms)
list "Sponsored (0036P and 0136P)" among the offer types that can run spot
VMs.

Neither AWS nor Google names spot usage outright. After the first day of runs,
check in your billing console that the VM charges were paid from credits.

## Committed spend: EDP, Google commitments and MACC

Larger companies often have a commitment instead of credits: they agreed to
spend a set amount with one cloud over a few years. Spending on CI inside that
cloud helps meet it. The terms are private, so what follows is what the clouds
publish.

| Agreement                                                                                                         | Can GitHub-hosted minutes count?                                                                                                                                       | Do VMs for self-hosted runners count?                                                                 |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| AWS EDP or private pricing                                                                                        | No. GitHub has no AWS billing route                                                                                                                                    | They're ordinary EC2 usage on your AWS bill. What counts is set in your agreement                     |
| Google Cloud commit contract                                                                                      | No. GitHub has no Google Cloud billing route                                                                                                                           | They're Compute Engine usage. Flexible committed use discounts can't be used for Spot VMs (see below) |
| [Azure MACC](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/track-consumption-commitment) | Yes, through a connected Azure subscription. GitHub's [reference](https://docs.github.com/en/billing/reference/azure-subscription) says the products are MACC-eligible | Azure VM consumption is eligible Azure spend; the portal lists which services decrement your MACC     |

Two rules from the clouds' docs change the math:

- Google's
  [committed use discount docs](https://docs.cloud.google.com/compute/docs/instances/committed-use-discounts-overview)
  say "you can't use your compute flexible commitments for Spot VMs or
  preemptible VMs". Spot runners still add to total spend under a contract,
  but they won't use a flexible CUD you've bought.
- Microsoft's MACC page says consumption that Azure credits cover doesn't
  count toward a MACC. A team with both uses credits first and decrements the
  MACC after.

For Azure customers with a MACC, both routes work: GitHub-hosted minutes
through a linked subscription, or self-hosted VMs. They differ in price per
minute.

## What the credits buy

GitHub's Linux 4-core runner costs $0.012 a minute
([runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)).
backmesh's [cost page](/cost/) prices a 4-vCPU, 16 GiB spot VM in one region
per cloud, from its catalog on 2026-11-13: AWS `us-east-2` $0.0497 to $0.07
an hour, Azure `westus2` $0.0318 to $0.0381, GCP `us-central1` $0.0899 to
$0.1165. Its control plane and one org's listener VM add about $86 a month on AWS,
$111 on Azure and $74 on GCP.

At those prices, a month of 4-vCPU jobs costs:

| Minutes a month | GitHub-hosted 4-core | AWS spot  | Azure spot | GCP spot    |
| --------------- | -------------------- | --------- | ---------- | ----------- |
| 20,000          | $240                 | $103–$109 | $122–$124  | $104–$113   |
| 150,000         | $1,800               | $210–$261 | $191–$206  | $299–$365   |
| 500,000         | $6,000               | $500–$669 | $376–$429  | $823–$1,045 |

The 150,000-minute row matches backmesh's published figures. The 20,000 and
500,000 rows are our own arithmetic with the same inputs. The spot figures
leave out disks, VM boots and reruns, so they're a floor. At 20,000 minutes
the always-on VMs are most of the bill. By the same arithmetic, below roughly
7,000 to 9,800 minutes a month of 4-core jobs, depending on the cloud,
GitHub-hosted runners cost less.

How long a credit balance lasts for CI alone, using the high end of each
range (our arithmetic, not a quote from any program):

| Balance  | GitHub-hosted, 150k min | AWS, 150k min | Azure, 150k min | GCP, 150k min | GitHub-hosted, 500k min | Azure, 500k min |
| -------- | ----------------------- | ------------- | --------------- | ------------- | ----------------------- | --------------- |
| $1,000   | 0.6 months              | 3.8 months    | 4.8 months      | 2.7 months    | 0.2 months              | 2.3 months      |
| $5,000   | 2.8 months              | 19 months     | 24 months       | 14 months     | 0.8 months              | 12 months       |
| $25,000  | 14 months               | 96 months     | 121 months      | 68 months     | 4.2 months              | 58 months       |
| $100,000 | 56 months               | 383 months    | 485 months      | 274 months    | 17 months               | 233 months      |

Two things follow. On a Microsoft for Startups balance, Azure spot VMs make
the same credits last about 9 to 14 times longer than paying GitHub through
the linked subscription. And for large balances, the credit runs out on its
expiry date long before the balance would. A $100,000 award that expires in
two years can't be spent on CI alone at these volumes. CI is a small share of
it, which is a reason to move CI onto it: the money is otherwise left unused
at expiry, and CI stops being a separate card charge.

To run your own minutes and sizes, use the [cost calculator](/calculator/).

## How to set it up

Any self-hosted runner that registers with your GitHub org and runs in your
cloud account puts CI on your cloud bill. Three free, open-source options:

| Option                                                                                           | Where it runs          | What you operate                                                            |
| ------------------------------------------------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------- |
| [Actions Runner Controller](https://github.com/actions/actions-runner-controller)                | Any Kubernetes cluster | The cluster and its node pools                                              |
| [terraform-aws-github-runner](https://github.com/github-aws-runners/terraform-aws-github-runner) | AWS                    | Terraform, Lambda functions and queues                                      |
| [backmesh](https://github.com/backmesh/backmesh)                                                 | AWS, GCP and Azure     | A control plane VM and a listener VM per org (t3.large and t3.small on AWS) |

Commercial runner managers that run machines in your own cloud account
include RunsOn and WarpBuild BYOC. Check each one's supported clouds and
pricing. For a side-by-side of the open-source three, see
[ARC vs terraform-aws-github-runner vs backmesh](/blog/arc-vs-terraform-aws-github-runner-vs-backmesh/).

backmesh is free and open source under Apache-2.0. It runs each job on its own
spot VM in your AWS, GCP or Azure account, deletes the VM when the job ends,
and charges no license or per-minute fee. Setup takes three steps:

1. Install the CLI with `curl -fsSL https://backmesh.com/install.sh | sh`.
2. Sign in to the cloud whose credits you want to use (`aws`, `gcloud` or
   `az`), then run `backmesh install --org <org>`. Add `--plan` first to see
   the VMs it will create and their prices without changing anything. The
   [install guide](/install/) covers the options.
3. In each workflow, change `runs-on: ubuntu-latest` to
   `runs-on: backmesh-4` for a 4-vCPU spot VM.

The cloud pages list what install creates in each account:
[AWS](/aws/), [GCP](/gcp/) and [Azure](/azure/). For credits, the account
matters: install into the AWS account, GCP billing account or Azure
sponsorship subscription that holds the credits. Credits on one account don't
move to another; Google says its credits "cannot be shared, split, or
resold", and Microsoft says startup benefits "can't be shared or merged with
multiple accounts".

backmesh has limits to weigh before you move. It runs Linux x86-64 only, with
no macOS, Windows or Arm runners, and NVIDIA T4 GPU runners on AWS and Azure
only. Only private repositories can use the
runners, unless you turn on [public repositories](/public-repos/). Each job waits for its VM to boot, about 30 seconds on AWS and 60 to
70 seconds on GCP and Azure. The image is Ubuntu 24.04 and lacks some of
GitHub's preinstalled toolchains, which setup actions add.

## What to watch

- Unused credit is gone at the end date on all three programs. Put the date
  in a calendar and check the balance monthly.
- All three programs exclude marketplace purchases. AWS excludes some support
  plans and Microsoft excludes all of them. A CI tool bought through a
  marketplace bills to your card.
- Google's credits cover 20% of eligible usage in the second year, so most of
  the CI bill becomes yours.
- The cloud can take a spot VM back at any time; Azure gives 30 seconds'
  notice. A reclaimed job fails. backmesh reruns it,
  preferring an on-demand VM, when reclaims were the run's only failures. On
  demand cost 1.7 to 5.4 times spot on 2026-11-13, so frequent reclaims raise
  the bill.
- New accounts start with low spot vCPU quotas. On GCP,
  `CPUS_ALL_REGIONS` defaults to 32 vCPUs, eight 4-vCPU jobs at once. Raise
  quotas before you move a busy repo.
- VM prices leave out disks, egress and NAT. Each backmesh runner
  has a 100 GB disk, about $0.038 an hour on AWS. Cache, artifact and image
  pushes that leave the cloud bill as egress. If your network sends runners
  through a NAT gateway, that bills per hour and per GB.
- GitHub announced a $0.002 per minute charge
  for self-hosted runners in private repositories on 2025-12-16 and
  [postponed it](https://github.com/orgs/community/discussions/182186) the
  next day. If it returns, it would bill to your GitHub payment method, not
  your credits: $300 a month at 150,000 minutes. See
  [the fee's status](/blog/github-self-hosted-runner-fee/).

## Questions

**Can I use AWS credits for GitHub Actions?** Not for GitHub-hosted runners.
GitHub's supported payment methods are invoice, credit card, PayPal, ACH and
an Azure subscription, and GitHub Enterprise hasn't been sold through AWS
Marketplace since 2021-05-12. AWS credits can pay for EC2 instances that run your jobs as
self-hosted runners.

**Can I use Google Cloud credits for GitHub Actions?** Not for GitHub-hosted
runners, since GitHub has no Google Cloud payment option. Google for Startups
credits apply to first-party Google Cloud products billed pay-as-you-go, which
includes the Compute Engine VMs that self-hosted runners use.

**Can Microsoft for Startups credits pay for GitHub Actions?** Yes, per
[Microsoft's startup docs](https://learn.microsoft.com/en-us/startups/build/getting-started/use-startup-credits),
once you connect your Azure sponsorship subscription to GitHub as a payment
method. GitHub then bills eligible usage-based services, including Actions,
against the credits. The credits can also pay for Azure VMs that run
self-hosted runners.

**Do startup credits cover spot or preemptible VMs?** As of 2026-11-18, AWS's
exclusions don't name EC2 or Spot, Google covers pay-as-you-go Compute Engine
usage, and Azure lists the Sponsored offer (0036P) as supporting Spot VMs.
Check your own award's terms.

**Does GitHub spend count toward an Azure MACC?** Yes, when billed through a
connected Azure subscription. GitHub's docs say those products are
MACC-eligible. Usage that Azure credits cover doesn't count toward a MACC.

**Does GitHub spend count toward an AWS EDP or private pricing commitment?**
GitHub-hosted minutes can't, since GitHub has no AWS billing route. EC2
instances running self-hosted runners are ordinary AWS usage. What counts is
set in your agreement.

**How long would credits last for CI?** By our arithmetic, 150,000 minutes a
month of 4-vCPU jobs cost about $206 to $365 a month at the high end of each
cloud, always-on VMs included. $5,000 lasts about 14 to 24 months at that
rate, against under 3 months on GitHub-hosted 4-core runners at $1,800 a
month.

**Do I need to change my workflows?** Only the `runs-on` line. With backmesh,
`runs-on: ubuntu-latest` becomes `runs-on: backmesh-4`. backmesh runs Linux
x86-64 jobs only, in private repositories unless you turn on
[public repositories](/public-repos/).

**Does GitHub charge for self-hosted runners?** Not as of 2026-11-18. The
$0.002 per minute fee announced on 2025-12-16 was postponed the next day, with
no new date.
