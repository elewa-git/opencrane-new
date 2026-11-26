{{- define "opencrane.computerRuntimeClass" -}}
gvisor
{{- end -}}

{{- define "opencrane.computerImagePull" -}}
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ .name }}
  annotations:
    helm.sh/hook: pre-install
    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
spec:
  activeDeadlineSeconds: 120
  ttlSecondsAfterFinished: 120
  backoffLimit: 0
  template:
    spec:
      runtimeClassName: {{ include "opencrane.computerRuntimeClass" .chart }}
      automountServiceAccountToken: false
      restartPolicy: Never
      {{- if .node }}
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchFields:
                  - key: metadata.name
                    operator: In
                    values: [{{ .node | quote }}]
      {{- end }}
      containers:
        - name: pull
          image: {{ .chart.Values.images.computer | quote }}
          imagePullPolicy: IfNotPresent
          command: [/bin/true]
          securityContext:
            runAsUser: 65534
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
          resources:
            requests: { cpu: 10m, memory: 16Mi }
            limits: { cpu: 50m, memory: 64Mi }
{{- end -}}
