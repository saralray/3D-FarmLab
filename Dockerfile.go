# Shared multi-stage build for the Go print-farm services (exporter, poller).
# Select which one to build with the SERVICE build-arg (the cmd/<SERVICE>
# package). Produces a static, CGO-free binary on a distroless base, so the
# runtime image is a few MB and idles at a fraction of the Python services' RAM.
ARG SERVICE=exporter

FROM golang:1.22-bookworm AS build
ARG SERVICE
WORKDIR /src

# Cache module downloads separately from the source.
COPY go-services/go.mod go-services/go.sum ./
RUN go mod download

COPY go-services/ ./
RUN CGO_ENABLED=0 GOFLAGS=-trimpath go build -ldflags="-s -w" \
      -o /out/service ./cmd/${SERVICE}

# distroless/static:nonroot — no shell, no package manager, runs as uid 65532.
FROM gcr.io/distroless/static-debian12:nonroot AS runtime
COPY --from=build /out/service /service
USER nonroot:nonroot
ENTRYPOINT ["/service"]
