#!/usr/bin/env python3
"""Build the public architecture figure from local, official AWS icons.

Run: python3 scripts/render_architecture.py [--png]
PNG export additionally needs rsvg-convert. No AWS access is used.
"""
from __future__ import annotations

import argparse
import base64
from html import escape
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
IMAGES = ROOT / "docs/images"
ICONS = IMAGES / "aws-icons"
INK, MUTED, BORDER = "#172b42", "#52677c", "#d5dee9"
BLUE, PURPLE, GREEN = "#1473b5", "#7154b3", "#167d72"


def text(x, y, value, size=16, color=INK, weight=400, anchor="start"):
    return (
        f'<text x="{x}" y="{y}" fill="{color}" font-size="{size}" '
        f'font-weight="{weight}" text-anchor="{anchor}" '
        'font-family="Arial, Helvetica, sans-serif">'
        f'{escape(value)}</text>'
    )


def image(path, x, y, width, height=None):
    encoded = base64.b64encode(path.read_bytes()).decode()
    return (
        f'<image x="{x}" y="{y}" width="{width}" height="{height or width}" '
        f'href="data:image/svg+xml;base64,{encoded}"/>'
    )


def icon(name, x, y, size=48):
    return image(ICONS / f"{name}.svg", x, y, size)


def box(x, y, width, height, fill="#ffffff", stroke=BORDER, dashed=False):
    dash = ' stroke-dasharray="7 5"' if dashed else ""
    return (
        f'<rect x="{x}" y="{y}" width="{width}" height="{height}" rx="12" '
        f'fill="{fill}" stroke="{stroke}" stroke-width="1.5"{dash}/>'
    )


def line(points, color=BLUE, dashed=False):
    marker = {BLUE: "blue", GREEN: "green", PURPLE: "purple"}[color]
    dash = ' stroke-dasharray="6 5"' if dashed else ""
    return (
        f'<path d="{points}" fill="none" stroke="{color}" stroke-width="2" '
        f'stroke-linejoin="round" marker-end="url(#{marker})"{dash}/>'
    )


def build():
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1152" '
        'viewBox="0 0 1440 1152" role="img" aria-labelledby="title description">',
        '<title id="title">EDDIE architecture</title>',
        '<desc id="description">The Cloudscape browser application is delivered through '
        'CloudFront and WAF from a private S3 origin. Cognito authenticates users. '
        'The browser calls AgentCore directly. AgentCore separates an optional Strands '
        'Advisor from a deterministic solver, reads model and pricing sources, and '
        'loads packaged skills and retrieves public AWS documentation through AWS Knowledge MCP, '
        'and persists projects and approvals in DynamoDB. Approved SageMaker trials use '
        'Lambda workers, S3 artifacts and ECR images. EventBridge schedules job recovery '
        'and independent cleanup. CloudWatch and SNS provide logs and cleanup alarms. '
        'A separately installed COA MCP knowledge service is optional.</desc>',
        '<defs>',
    ]
    for name, color in (("blue", BLUE), ("green", GREEN), ("purple", PURPLE)):
        parts.append(
            f'<marker id="{name}" viewBox="0 0 10 10" refX="9" refY="5" '
            f'markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
            f'<path d="M0 0L10 5L0 10Z" fill="{color}"/></marker>'
        )
    parts += [
        '</defs><rect width="1440" height="1152" fill="#ffffff"/>',
        image(ROOT / "frontend/public/brand/eddie-wordmark-color-v1.svg", 40, 30, 134, 30),
        text(198, 55, "Architecture", 29, INK, 700),
        text(40, 91, "Model discovery and comparison, followed by an approved inference trial.", 18, MUTED),

        # The static delivery path is deliberately separate from the API path.
        box(284, 132, 1116, 164, "#f6f8fc"),
        text(308, 158, "APP DELIVERY", 13, MUTED, 700),
        box(320, 178, 450, 88),
        icon("cloudfront", 338, 196),
        icon("waf", 397, 196),
        text(465, 216, "CloudFront + AWS WAF", 21, INK, 700),
        text(465, 242, "Static application delivery", 16, MUTED),
        box(1040, 178, 328, 88),
        icon("s3", 1059, 196),
        text(1124, 216, "Amazon S3", 21, INK, 700),
        text(1124, 242, "Private frontend origin", 16, MUTED),
        line("M770 222H1040"),
        text(905, 208, "Origin access control", 15, MUTED, anchor="middle"),

        # Browser and authentication are client interactions, not an API Gateway.
        box(40, 340, 204, 176, "#f6f8fc"),
        icon("users", 116, 359, 52),
        text(142, 440, "Cloudscape app", 21, INK, 700, "middle"),
        text(142, 468, "Manual workspace", 16, MUTED, anchor="middle"),
        text(142, 492, "Optional Advisor", 16, MUTED, anchor="middle"),
        line("M142 340V222H320"),
        text(156, 310, "App files", 15, MUTED),
        line("M244 429H320"),
        text(282, 414, "API", 14, BLUE, 700, "middle"),
        box(40, 578, 204, 114),
        icon("cognito", 56, 595, 42),
        text(110, 611, "Amazon", 17, INK, 700),
        text(110, 634, "Cognito", 19, INK, 700),
        text(142, 670, "User sign-in", 16, MUTED, anchor="middle"),
        line("M142 516V578"),
        text(155, 553, "Sign in", 15, MUTED),

        # Internal software responsibilities sit inside one actual runtime.
        box(320, 332, 530, 298, "#f8f6fd", "#c7b7e6"),
        icon("agentcore", 344, 353, 52),
        text(412, 375, "Amazon Bedrock AgentCore", 23, INK, 700),
        text(344, 424, "Authenticated API · project access · answer streaming", 16, MUTED),
        box(344, 443, 224, 130),
        text(360, 473, "Strands Advisor", 20, INK, 700),
        text(360, 499, "Intake + skill guidance", 16, MUTED),
        icon("bedrock", 360, 523, 30),
        text(400, 544, "Bedrock model", 16, MUTED),
        box(596, 443, 230, 130),
        text(612, 473, "Deterministic solver", 19, INK, 700),
        text(612, 502, "Check requirements", 16, MUTED),
        text(612, 528, "Then minimize cost", 16, MUTED),
        line("M568 510H596", PURPLE),
        text(344, 603, "Missing evidence stays unverified.", 17, PURPLE, 700),

        box(950, 332, 450, 242, "#f6faf9"),
        icon("bedrock", 970, 352, 48),
        text(1036, 377, "Models & sources", 23, INK, 700),
        text(974, 434, "Amazon Bedrock catalog", 18),
        text(974, 472, "AWS Price List + Service Quotas", 18),
        text(974, 510, "Hugging Face model metadata", 18),
        text(974, 548, "AWS Knowledge MCP · current documentation", 15, MUTED),
        line("M850 396H950"),
        text(900, 381, "Read", 15, MUTED, anchor="middle"),

        box(950, 612, 450, 144),
        icon("dynamodb", 970, 633, 48),
        text(1036, 658, "Amazon DynamoDB", 22, INK, 700),
        text(974, 702, "Projects · messages · tool results", 17, MUTED),
        text(974, 732, "Decisions · approvals · resource ledger", 17, MUTED),
        line("M850 596H902V684H950"),

        # COA is an adapter plus separately installed stack, not an implicit cost.
        box(40, 754, 204, 210, "#fcfaff", "#c7b7e6", True),
        text(60, 786, "OPTIONAL", 13, PURPLE, 700),
        text(60, 820, "COA knowledge", 20, INK, 700),
        text(60, 850, "MCP connection", 16, MUTED),
        text(60, 887, "Separate installation", 15, MUTED),
        text(60, 915, "Disabled by default", 15, MUTED),
        line("M244 854H272V596H320", PURPLE, True),

        # Current execution is Lambda + scheduled recovery, not planned Step Functions.
        box(284, 682, 616, 318, "#f5faf8", "#b9d9d0"),
        text(308, 713, "APPROVED TRIALS", 13, GREEN, 700),
        box(320, 746, 540, 86),
        icon("lambda", 339, 765, 48),
        text(408, 782, "Lambda trial workers", 22, INK, 700),
        text(408, 810, "Validate · stage · deploy · invoke", 17, MUTED),
        line("M585 630V746", GREEN),
        text(600, 660, "Approved plan", 15, GREEN),
        box(320, 874, 210, 92),
        icon("eventbridge", 334, 891, 36),
        text(381, 908, "EventBridge", 18, INK, 700),
        text(334, 945, "Scheduled recovery", 16, MUTED),
        box(600, 874, 260, 92),
        icon("lambda", 616, 891, 36),
        text(664, 908, "Cleanup worker", 19, INK, 700),
        text(616, 945, "Expiry + removal checks", 16, MUTED),
        line("M425 874V832", GREEN),
        line("M530 920H600", GREEN),

        box(950, 794, 450, 206, "#f5faf8", "#b9d9d0"),
        icon("sagemaker-ai", 970, 814, 48),
        text(1036, 840, "SageMaker AI endpoint", 23, INK, 700),
        text(974, 883, "Bounded GPU trial · authenticated test calls", 17, MUTED),
        text(974, 915, "Isolated model container · private subnets", 17, MUTED),
        icon("s3", 975, 945, 29),
        text(1014, 966, "Model files", 16, MUTED),
        icon("ecr", 1154, 945, 29),
        text(1194, 966, "Serving image", 16, MUTED),
        line("M860 789H916V844H950", GREEN),
        line("M860 920H950", GREEN),
        text(905, 904, "Remove", 14, GREEN, anchor="middle"),

        # Shared platform services: omit account identifiers and AppSec internals.
        box(40, 1040, 1360, 80, "#f6f8fc"),
        icon("cloudwatch", 62, 1062, 36),
        text(110, 1075, "CloudWatch", 18, INK, 700),
        text(110, 1100, "Logs and alarms", 15, MUTED),
        icon("sns", 349, 1062, 36),
        text(397, 1075, "Amazon SNS", 18, INK, 700),
        text(397, 1100, "Cleanup notifications", 15, MUTED),
        icon("iam", 656, 1062, 36),
        icon("kms", 700, 1062, 36),
        text(748, 1075, "IAM + KMS", 18, INK, 700),
        text(748, 1100, "Scoped access and encryption", 15, MUTED),
        icon("cloudformation", 1080, 1062, 36),
        text(1130, 1075, "CloudFormation", 18, INK, 700),
        text(1130, 1100, "Application installation", 15, MUTED),
        '</svg>',
    ]
    return "".join(parts) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--png", action="store_true", help="Also render PNG with rsvg-convert.")
    args = parser.parse_args()
    output = IMAGES / "architecture.svg"
    output.write_text(build())
    if args.png:
        subprocess.run(["rsvg-convert", "-o", str(output.with_suffix(".png")), str(output)], check=True)
    print(output.relative_to(ROOT))


if __name__ == "__main__":
    main()
