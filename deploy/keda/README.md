# KEDA on agent-platform

KEDA drives the Runner's HorizontalPodAutoscaler. It is cluster-wide: one
install serves `oma-test` and `oma-infra`, and it ignores every other namespace
(`watchNamespace` in [values.yaml](values.yaml)).

| | |
|---|---|
| Chart | ACK App Catalog `ack-keda` 2.21.0 (KEDA 2.21.0, `kubeVersion >=v1.34.0-0`) |
| Chart digest | `sha256:84e2b37afb632496ecd89aba8cd823f9b96934c0e4a1f05366f0986577914b12` |
| Release | `ack-keda` in `kube-system` |
| Images | `registry-cn-shanghai-vpc.ack.aliyuncs.com/acs/keda*:2.21.0` |
| Installed | 2026-11-04 13:57Z, Kubernetes v1.36.1-aliyun.1 |

The chart is not in ACK component management; the console installs it from
Applications > Helm. A CLI install must set the image region itself, which the
console otherwise substitutes for `__ACK_REGION_ID__`.

## Install or upgrade

Download the chart into an empty directory and check it against the catalog
index before using it:

```bash
mkdir -p /tmp/ack-keda-chart && cd /tmp/ack-keda-chart
curl -fsSLO https://aliacs-app-catalog.oss-cn-hangzhou.aliyuncs.com/charts-incubator/ack-keda-2.21.0.tgz
shasum -a 256 ack-keda-2.21.0.tgz   # must equal the digest above
cd -
helm upgrade --install ack-keda /tmp/ack-keda-chart/ack-keda-2.21.0.tgz \
  -n kube-system -f deploy/keda/values.yaml --wait --timeout 10m
```

On upgrade the chart's pre-upgrade Job updates the CRDs.

## Verify

```bash
kubectl -n kube-system get pods -l app.kubernetes.io/part-of=keda-operator
kubectl get apiservice v1beta1.external.metrics.k8s.io   # AVAILABLE True
kubectl get --raw /apis/external.metrics.k8s.io/v1beta1
```

At start the operator restarts once and the metrics server logs gRPC dial
failures until the operator holds its leader lease; both settle within about
30 s.

## Failure behavior

- KEDA serves `external.metrics.k8s.io`, of which a cluster has exactly one
  provider; installing another external metrics adapter would conflict.
- While the metrics server is down, every KEDA-driven HPA keeps its current
  replica count, and API discovery reports the group unavailable.
- The admission webhook validates only KEDA objects (ScaledObject,
  TriggerAuthentication and their kin) with `failurePolicy: Ignore`.

## Remove

Delete the ScaledObjects first: their Deployments keep the replica count they
have at that moment. Then:

```bash
helm uninstall ack-keda -n kube-system
# Helm keeps CRDs from crds/; remove them only when no KEDA object remains.
kubectl get crd -o name | grep keda.sh | xargs kubectl delete
```
