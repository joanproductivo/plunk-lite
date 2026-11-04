<h1 align="center">Plunk Lite</h1>

<p align="center">
    A lighter, self-hosted email platform, built on <a href="https://github.com/useplunk/plunk">Plunk</a>
</p>

## About this project

Plunk Lite is an **unofficial, independently versioned fork** of [Plunk](https://github.com/useplunk/plunk) for people who run their own installation on Amazon SES. One person maintains it. It is not made or supported by the Plunk team, so please don't send them questions about it.

It started from Plunk 0.17.0 and has been modified since 2026-10-24. New Plunk releases are not merged whole: each one is reviewed, and only the changes that suit this fork are brought in. Fixes that also apply to Plunk are offered back to it as pull requests.

Thanks to the Plunk team for the platform this is built on. If you find Plunk useful, consider [sponsoring it](https://github.com/sponsors/driaug).

## What's different from Plunk

**Lighter**

- No landing site, wiki or SMTP relay
- The dashboard is a static export served by nginx, with no Next.js server
- The dashboard doesn't load the hosted Plunk service's analytics script from a third party. Your email statistics are all still there

**Added**

- **Email editor:** styles inlined at send time, preheader, buttons, dividers, spacers, a `/` menu, an image gallery, brand styles, a per-language unsubscribe footer, YouTube videos and boxes with a background
- **Static segments:** with entry and exit events, usable in bulk from Contacts, on the contact page and in workflows
- **Campaigns:** leave out the contacts of up to 20 segments, whatever the audience
- **Filters and conditions:** "is not member of" counts contacts without the field, "not equals" warns that it leaves them out, a filter value the query can't compare is refused with a 400 that names the filter instead of a server error, and workflow conditions compare dates as dates, the contact's creation date included
- **Contacts:** CSV export, and import with segments and signup dates
- **Double opt-in:** per project, off by default
- **Suppression you can see:** a "Suppressed" status with its reason, and removal that also clears the address from SES
- **Sending safeguards:** a cut-off for repeated soft bounces, automatic clicks left out of the statistics, and a DMARC check for each domain
- **Template data as text:** in email bodies, `{{ variables }}` are HTML-escaped (add `| raw` to print HTML you trust), data never runs as Liquid when an email is rendered again, and links in emails that are not custom HTML can only go to web, mail, phone or text-message addresses and anchors
- **Failure alerts:** a dashboard banner and emails, covering sending reputation and domains SES stops verifying
- **Webhook steps:** HMAC signatures, retries with backoff and a Retry button on failed executions
- **SES event recovery:** the dead-letter queue is drained automatically

**Missing**

Some features of newer Plunk releases are left out on purpose, such as scheduled delivery and throttling (Plunk 0.18.0), and so is the SMTP relay. If you need them, use [Plunk](https://github.com/useplunk/plunk).

## Self-hosting

Images are published to `ghcr.io/joanproductivo/plunk-lite`, for amd64 and arm64:

- `sha-<commit>`: one for each build. Pin one of these in production.
- `latest`: the newest build. Use it to find out which `sha-` is current, not in a compose file.

Named versions such as `lite-1.0.0` are Git tags and [releases](https://github.com/joanproductivo/plunk-lite/releases) that mark milestones. There is no image with that name: each release says which `sha-` it matches.

To install it on [Dokploy](https://dokploy.com) with Amazon SES, use the [plunk-dokploy-ses](https://github.com/joanproductivo/plunk-dokploy-ses) skill.

Plunk's [documentation](https://docs.useplunk.com) still applies to the features the two share, but it describes the official version.

**Switching from Plunk:** this fork adds its own tables, prefixed `plunk_lite_`, and doesn't alter Plunk's. Even so, back up your database first, and don't assume that an installation can move in either direction without losing anything: emails built with this fork's editor, workflows and queued jobs can behave differently on the official image.

## Versions

Plunk Lite has its own numbering, unrelated to Plunk's. The second number goes up for new features and the third for fixes. See [CHANGELOG.md](CHANGELOG.md).

Issues are turned off on this repository, so support is not provided. Anyone is welcome to use and adapt the code under its license.

## License

AGPL-3.0, the same license as Plunk. See [LICENSE](LICENSE).

Plunk is the work of its authors. This fork's changes can be seen in the commit history of this repository.
