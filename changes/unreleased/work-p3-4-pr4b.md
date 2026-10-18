Published tool calls now save one start record before sending any bytes. A lost save reply,
withdrawal or access change during saving refuses the call and spends its one-use pass.
A newer gateway configuration saved during the last tool-rule read also refuses the call,
even when that server's rules stay the same. Changes caught before saving leave no start record.
A refusal after a confirmed start now records that nothing was sent. The last gateway
position read sets the boundary: a newer configuration visible then refuses the call;
a later save allows the checked call to send once on the still acknowledged configuration.
The guarded production destination and live journey remain pending.
