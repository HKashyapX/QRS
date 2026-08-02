#include <opencv2/opencv.hpp>
#include <fstream>
#include <vector>
#include <string>

using namespace cv;
using namespace std;

const int GRID_SIZE = 64;
const int CELL_SIZE = 8;
const int WINDOW_SIZE = GRID_SIZE * CELL_SIZE;
const int PAYLOAD_DIM = GRID_SIZE - 2;
const int MAX_BYTES = (PAYLOAD_DIM * PAYLOAD_DIM) / 8;

void transmit(const string& filepath) {
    ifstream file(filepath, ios::binary | ios::ate);
    streamsize size = file.tellg();
    file.seekg(0, ios::beg);
    
    vector<char> buffer(MAX_BYTES, 0);
    if (size > 0) file.read(buffer.data(), min((int)size, MAX_BYTES));

    Mat grid = Mat::zeros(GRID_SIZE, GRID_SIZE, CV_8UC1);
    
    for (int i = 0; i < GRID_SIZE; i++) {
        grid.at<uchar>(0, i) = (i % 2 == 0) ? 255 : 0;
        grid.at<uchar>(GRID_SIZE - 1, i) = (i % 2 == 0) ? 0 : 255;
        grid.at<uchar>(i, 0) = (i % 2 == 0) ? 255 : 0;
        grid.at<uchar>(i, GRID_SIZE - 1) = (i % 2 == 0) ? 0 : 255;
    }
    grid.at<uchar>(0, 0) = 255;
    grid.at<uchar>(0, GRID_SIZE - 1) = 255;
    grid.at<uchar>(GRID_SIZE - 1, 0) = 255;
    grid.at<uchar>(GRID_SIZE - 1, GRID_SIZE - 1) = 255;

    int bit_idx = 0;
    for (int y = 1; y < GRID_SIZE - 1; y++) {
        for (int x = 1; x < GRID_SIZE - 1; x++) {
            int byte_idx = bit_idx / 8;
            int bit_pos = 7 - (bit_idx % 8);
            bool bit_val = (buffer[byte_idx] >> bit_pos) & 1;
            grid.at<uchar>(y, x) = bit_val ? 255 : 0;
            bit_idx++;
        }
    }

    Mat frame_a, frame_b;
    resize(grid, frame_a, Size(WINDOW_SIZE, WINDOW_SIZE), 0, 0, INTER_NEAREST);
    bitwise_not(frame_a, frame_b);

    namedWindow("TX", WINDOW_NORMAL);
    resizeWindow("TX", WINDOW_SIZE, WINDOW_SIZE);

    while (true) {
        imshow("TX", frame_a);
        if (waitKey(16) == 27) break;
        imshow("TX", frame_b);
        if (waitKey(16) == 27) break;
    }
}

void receive() {
    VideoCapture cap(0, CAP_V4L2);
    cap.set(CAP_PROP_FRAME_WIDTH, 1280);
    cap.set(CAP_PROP_FRAME_HEIGHT, 720);
    cap.set(CAP_PROP_FPS, 60);

    Mat prev, curr, diff, thresh;
    cap >> prev;
    if (prev.empty()) return;
    cvtColor(prev, prev, COLOR_BGR2GRAY);

    while (true) {
        cap >> curr;
        if (curr.empty()) break;
        
        Mat curr_gray;
        cvtColor(curr, curr_gray, COLOR_BGR2GRAY);
        
        absdiff(curr_gray, prev, diff);
        threshold(diff, thresh, 100, 255, THRESH_BINARY);
        
        vector<vector<Point>> contours;
        findContours(thresh, contours, RETR_EXTERNAL, CHAIN_APPROX_SIMPLE);
        
        for (const auto& contour : contours) {
            double area = contourArea(contour);
            if (area > 5000) {
                vector<Point> approx;
                approxPolyDP(contour, approx, 0.02 * arcLength(contour, true), true);
                if (approx.size() == 4) {
                    vector<Point2f> src_pts;
                    for (const auto& p : approx) src_pts.push_back(Point2f(p.x, p.y));
                    
                    vector<Point2f> dst_pts = {
                        Point2f(0, 0),
                        Point2f(0, WINDOW_SIZE - 1),
                        Point2f(WINDOW_SIZE - 1, WINDOW_SIZE - 1),
                        Point2f(WINDOW_SIZE - 1, 0)
                    };
                    
                    Mat H = findHomography(src_pts, dst_pts);
                    if (!H.empty()) {
                        Mat warped;
                        warpPerspective(thresh, warped, H, Size(WINDOW_SIZE, WINDOW_SIZE));
                        imshow("RX_WARPED", warped);
                        
                        vector<char> rx_buffer(MAX_BYTES, 0);
                        int bit_idx = 0;
                        for (int y = 1; y < GRID_SIZE - 1; y++) {
                            for (int x = 1; x < GRID_SIZE - 1; x++) {
                                int px_x = x * CELL_SIZE + (CELL_SIZE / 2);
                                int px_y = y * CELL_SIZE + (CELL_SIZE / 2);
                                uchar val = warped.at<uchar>(px_y, px_x);
                                
                                if (val > 127) {
                                    int byte_idx = bit_idx / 8;
                                    int bit_pos = 7 - (bit_idx % 8);
                                    rx_buffer[byte_idx] |= (1 << bit_pos);
                                }
                                bit_idx++;
                            }
                        }
                    }
                }
            }
        }
        
        imshow("RX_RAW", curr_gray);
        imshow("RX_DIFF", thresh);
        
        if (waitKey(1) == 27) break;
        prev = curr_gray.clone();
    }
}

int main(int argc, char** argv) {
    if (argc < 2) return 1;
    string mode = argv[1];
    
    if (mode == "--tx" && argc == 3) {
        transmit(argv[2]);
    } else if (mode == "--rx") {
        receive();
    }
    return 0;
}
