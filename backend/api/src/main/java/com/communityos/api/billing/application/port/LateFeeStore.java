package com.communityos.api.billing.application.port;

import com.communityos.api.billing.domain.LateFees;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** What the late-fee run reads, and how a fee bill is tied to the bill it is charged on (explicit SQL: JdbcLateFeeStore). */
public interface LateFeeStore {
    LateFees.Settings settings();
    /** Unpaid and partly paid bills that are past their due date (late fees themselves left out). */
    List<LateFees.Bill> overdue();
    /** Fees already charged: "billId#no". */
    Set<String> charged();
    /** Tie a raised fee bill to its bill and month; false when that month's fee exists already (another run got there first). */
    boolean tie(UUID feeBillId, UUID forBillId, int no);
}
