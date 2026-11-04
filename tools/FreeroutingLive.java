import app.freerouting.Freerouting;
import app.freerouting.management.RoutingJobScheduler;
import java.nio.file.*;
import java.util.Arrays;

/** Observe the router's already-serialized SES output; never traverse or mutate its board. */
public class FreeroutingLive {
    public static void main(String[] args) {
        Path destination = Path.of(args[0]);
        Thread observer = new Thread(() -> {
            byte[] previous = null;
            while (true) {
                try {
                    if (Freerouting.globalSettings != null) {
                        for (var job : RoutingJobScheduler.getInstance().listJobs()) {
                            var output = job.output;
                            if (output != null && output.getData() != null) {
                                byte[] data = output.getData().readAllBytes();
                                if (data.length > 0 && !Arrays.equals(data, previous)) {
                                    Path temp = destination.resolveSibling(destination.getFileName() + ".tmp");
                                    Files.write(temp, data);
                                    Files.move(temp, destination, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                                    previous = data;
                                }
                            }
                        }
                    }
                } catch (Exception ex) {
                    System.err.println("Live preview: " + ex.getMessage());
                }
                try { Thread.sleep(2000); } catch (InterruptedException ex) { return; }
            }
        }, "board-preview");
        observer.setDaemon(true);
        observer.start();
        Freerouting.main(Arrays.copyOfRange(args, 1, args.length));
    }
}
