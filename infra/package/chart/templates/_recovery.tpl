{{- define "opencrane.recoveryGuard" -}}
{{- if hasKey .Values.postgres "recovery" -}}
{{- $recovery := .Values.postgres.recovery -}}
{{- if not (and (eq .Values.postgres.mode "cnpg") (kindIs "map" $recovery)) -}}
{{- fail "CNPG recovery requires CNPG mode and explicit preview settings" -}}
{{- end -}}
{{- if hasKey .Values.postgres "backup" -}}
{{- fail "CNPG recovery cannot configure a backup archive writer" -}}
{{- end -}}
{{- $allowed := list "enabled" "renderOnly" "method" "destinationPath" "endpointURL"
                    "endpointCA" "s3Credentials" "source" "serverName" "recoveryTarget" -}}
{{- range $field, $value := $recovery -}}
{{- if not (has $field $allowed) -}}
{{- fail "Unsupported CNPG recovery setting" -}}
{{- end -}}
{{- end -}}
{{- range $field := list "enabled" "renderOnly" -}}
{{- $value := index $recovery $field -}}
{{- if not (and (kindIs "bool" $value) $value) -}}
{{- fail "CNPG recovery requires enabled and renderOnly to be true" -}}
{{- end -}}
{{- end -}}
{{- range $field := list "source" "serverName" -}}
{{- $value := index $recovery $field -}}
{{- if not (and (kindIs "string" $value) (le (len $value) 63)
      (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" $value)) -}}
{{- fail "CNPG recovery requires an explicit source binding and server name" -}}
{{- end -}}
{{- end -}}
{{- include "opencrane.objectStoreGuard" (dict "store" $recovery "namespace" .Release.Namespace) -}}
{{- include "opencrane.recoveryTargetGuard" $recovery.recoveryTarget -}}
{{- end -}}
{{- end -}}

{{- define "opencrane.recoveryTargetGuard" -}}
{{- if not (kindIs "map" .) -}}
{{- fail "CNPG recovery requires an exact recovery target" -}}
{{- end -}}
{{- range $field, $value := . -}}
{{- if not (has $field (list "backupID" "targetLSN" "targetTLI")) -}}
{{- fail "CNPG recovery accepts only backupID, targetLSN and targetTLI" -}}
{{- end -}}
{{- end -}}
{{- $backupPattern := "^[0-9]{8}T[0-9]{6}$" -}}
{{- if not (and (kindIs "string" .backupID) (regexMatch $backupPattern .backupID)) -}}
{{- fail "CNPG recovery requires an explicit Barman backup ID" -}}
{{- end -}}
{{/* Keep calendar validation independent of the workstation's time zone. */}}
{{- $backupTime := toDate "20060102T150405Z0700" (printf "%sZ" .backupID) -}}
{{- if ne (dateInZone "20060102T150405" $backupTime "UTC") .backupID -}}
{{- fail "CNPG recovery requires a valid Barman backup timestamp" -}}
{{- end -}}
{{- if not (and (kindIs "string" .targetLSN)
      (regexMatch "^[0-9A-Fa-f]{1,8}/[0-9A-Fa-f]{1,8}$" .targetLSN)) -}}
{{- fail "CNPG recovery requires an explicit WAL LSN" -}}
{{- end -}}
{{- if not (and (kindIs "string" .targetTLI)
      (regexMatch "^[1-9][0-9]{0,9}$" .targetTLI)) -}}
{{- fail "CNPG recovery requires an explicit numeric timeline" -}}
{{- end -}}
{{- if gt (int64 .targetTLI) 4294967295 -}}
{{- fail "CNPG recovery timeline is out of range" -}}
{{- end -}}
{{- end -}}
