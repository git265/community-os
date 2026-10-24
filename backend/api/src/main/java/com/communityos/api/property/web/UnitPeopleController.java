package com.communityos.api.property.web;

import com.communityos.api.property.application.UnitPeopleService;
import com.communityos.api.property.application.port.UnitPeople;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.tenancy.CallerHolder;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Size;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Who lives in or owns a unit, over time: its people, its history, a move-out and a change of owner. */
@RestController
@RequestMapping("/api/v1/units/{id}")
@Tag(name = "Units")
public class UnitPeopleController {
    public record PersonBody(UUID occupantId, @Size(max = 120) String name, @Size(max = 30) String phone, @Size(max = 200) String email, @Size(max = 20) String relation, Boolean primary) {
        UnitPeopleService.PersonIn in() { return new UnitPeopleService.PersonIn(occupantId, name, phone, email, relation, primary); }
    }
    public record PeopleBody(@Size(max = 50) List<@Valid PersonBody> people, @Size(max = 20) String occupancy, @Size(max = 10) String billTo) {}
    public record MoveOutBody(LocalDate on, @Size(min = 1, max = 50) List<UUID> occupantIds, @Size(max = 20) String occupancyAfter, Boolean endGate, @Size(max = 2000) String note) {}
    public record ChangeOwnerBody(LocalDate on, @Valid PersonBody newOwner, @Size(max = 10) List<@Valid PersonBody> coOwners, @Size(max = 50) List<UUID> leavingIds,
                                  @Size(max = 20) String occupancyAfter, Boolean endGate, @Size(max = 2000) String note) {}

    private final UnitPeopleService people;
    public UnitPeopleController(UnitPeopleService people) { this.people = people; }

    /** The unit's people now; with history=true (the unit's managers and the committee) also those who lived there before, with the days. */
    @GetMapping("/people")
    public List<UnitPeople.Person> people(@PathVariable UUID id, @RequestParam(defaultValue = "false") boolean history) {
        return people.people(CallerHolder.require(), new UnitId(id), history);
    }
    /** The unit's contacts as the unit form has them: someone left out has left today (kept in the history), someone new is added from today. */
    @PutMapping("/people")
    public List<UnitPeople.Person> save(@PathVariable UUID id, @Valid @RequestBody PeopleBody b) {
        return people.save(CallerHolder.require(), new UnitId(id), new UnitPeopleService.SavePeople(b.people() == null ? List.of() : b.people().stream().map(PersonBody::in).toList(),
            b.occupancy(), b.billTo()));
    }
    @GetMapping("/leftovers")
    public UnitPeople.Leftovers leftovers(@PathVariable UUID id, @RequestParam(required = false) @Size(max = 50) List<UUID> leaving) {
        return people.leftovers(CallerHolder.require(), new UnitId(id), leaving);
    }
    @GetMapping("/changes")
    public List<UnitPeople.Change> changes(@PathVariable UUID id) { return people.history(CallerHolder.require(), new UnitId(id)); }

    @PostMapping("/move-out")
    public UnitPeopleService.Outcome moveOut(@PathVariable UUID id, @Valid @RequestBody MoveOutBody b) {
        return people.moveOut(CallerHolder.require(), new UnitId(id), new UnitPeopleService.MoveOut(b.on(), b.occupantIds(), b.occupancyAfter(), b.endGate(), b.note()));
    }
    @PostMapping("/change-owner")
    public UnitPeopleService.Outcome changeOwner(@PathVariable UUID id, @Valid @RequestBody ChangeOwnerBody b) {
        return people.changeOwner(CallerHolder.require(), new UnitId(id), new UnitPeopleService.ChangeOwner(b.on(), b.newOwner() == null ? null : b.newOwner().in(),
            b.coOwners() == null ? List.of() : b.coOwners().stream().map(PersonBody::in).toList(), b.leavingIds(), b.occupancyAfter(), b.endGate(), b.note()));
    }
}
