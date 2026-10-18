Published tool calls now save one start record before sending any bytes. A lost save reply,
withdrawal or access change during saving refuses the call and spends its one-use pass.
A newer gateway configuration saved during the last tool-rule read also refuses the call,
even when that server's rules stay the same. Changes caught before saving leave no start record.
The guarded production destination and live journey remain pending.
