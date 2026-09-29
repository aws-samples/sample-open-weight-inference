# AWS architecture icons

These unmodified icons come from the **July 31, 2026 AWS Architecture Icons**
package, available from [AWS Architecture Icons](https://aws.amazon.com/architecture/icons/).
AWS owns the service artwork; use is subject to AWS's published icon and trademark guidelines.

The public diagram embeds these local SVGs. It does not fetch images, scripts or
fonts from a CDN. `sagemaker-ai.svg` is the **Amazon SageMaker AI** service icon,
not the separate Amazon SageMaker analytics platform icon.

To regenerate the figure:

```bash
python3 scripts/render_architecture.py --png
```

Omit `--png` when `rsvg-convert` is not installed.
