FROM public.ecr.aws/lambda/python:3.12

# Install FFmpeg and system dependencies
RUN dnf install -y \
    ffmpeg \
    libass \
    && dnf clean all

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy handler code
COPY handler.py .

CMD ["handler.handler"]
